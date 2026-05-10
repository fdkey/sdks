"""Bounded per-server session store. Mirrors the TS SDK's session-store.ts:
TTL eviction + LRU hard cap, both running together.

Python's `dict` preserves insertion order (3.7+), so re-inserting on touch
moves the entry to the tail and the head is always the LRU. O(1) eviction.

Thread safety: all mutating operations are guarded by a `threading.Lock`.
The asyncio-only convention of the mcp Python SDK doesn't need this on
the hot path, but integrators who wrap FDKEY in a thread-pool web
framework (Flask, Quart-with-`run_sync`, asyncio.to_thread) shouldn't
hit a TOCTOU race where two threads both miss for the same session id
and end up with one of their `SessionState` mutations becoming garbage.
The lock is uncontended in single-threaded asyncio (~100 ns) — invisible
against any real workload.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Optional

from .guard import new_session
from .types import SessionState

# Drop sessions untouched longer than this. One hour is comfortably longer
# than the default JWT lifetime (~5 min) plus typical agent retry/backoff,
# so an active session is never evicted while it could legitimately make
# another call.
SESSION_IDLE_TTL_MS = 60 * 60 * 1000

# Hard cap on the per-server session map. Hit this only on pathological
# burst traffic — eviction is O(1) thanks to dict insertion-order semantics.
MAX_SESSIONS = 10_000


def _now_ms_default() -> int:
    return int(time.time() * 1000)


class SessionStore:
    """Two eviction policies running together:
      1. Idle TTL: sessions untouched for `idle_ttl_ms` are dropped on
         next miss. Sweep-on-access drops at most one stale entry from
         the head of the dict per call (O(1) amortized).
      2. LRU cap: when the dict reaches `max_size`, the head (which is
         the LRU entry by insertion order) is dropped before insert.
    Net effect: long-lived MCP servers don't leak session memory regardless
    of whether the underlying transport delivers clean disconnect signals.
    """

    def __init__(
        self,
        max_size: int = MAX_SESSIONS,
        idle_ttl_ms: int = SESSION_IDLE_TTL_MS,
        now_ms: Optional[Callable[[], int]] = None,
    ) -> None:
        self._max_size = max_size
        self._idle_ttl_ms = idle_ttl_ms
        self._now_ms = now_ms or _now_ms_default
        self._sessions: dict[str, SessionState] = {}
        # Reentrant lock so the gc-finalizer in middleware.py can call
        # `delete()` while a `get()` is still on the stack on the same
        # thread (rare but possible if a finalizer fires synchronously
        # mid-operation under aggressive gc tuning).
        self._lock = threading.RLock()

    def get(self, sid: str) -> SessionState:
        """Get-or-create the session for `sid`, sliding the LRU position to
        the tail. Opportunistically evicts one stale entry per miss, and
        force-evicts the LRU when at the size cap."""
        with self._lock:
            t = self._now_ms()
            existing = self._sessions.get(sid)
            if existing is not None:
                # Slide to the tail of the LRU order: pop + re-insert is O(1).
                del self._sessions[sid]
                existing.last_touched_at = t
                self._sessions[sid] = existing
                return existing

            # Miss → opportunistic TTL sweep of the head, then enforce the cap.
            if self._sessions:
                head_sid = next(iter(self._sessions))
                head_session = self._sessions[head_sid]
                if t - head_session.last_touched_at > self._idle_ttl_ms:
                    del self._sessions[head_sid]

            if len(self._sessions) >= self._max_size:
                # Force-evict the LRU regardless of age.
                lru_sid = next(iter(self._sessions))
                del self._sessions[lru_sid]

            fresh = new_session()
            fresh.last_touched_at = t
            self._sessions[sid] = fresh
            return fresh

    def peek(self, sid: str) -> Optional[SessionState]:
        """Read-only access. Does NOT slide LRU position. Used by
        `get_fdkey_context()` so reading verification context doesn't
        extend a session's lifetime."""
        with self._lock:
            return self._sessions.get(sid)

    def delete(self, sid: str) -> bool:
        """Remove a session. Used by `_SessionKeyTracker`'s gc-finalizer
        when a `ServerSession` is collected. Returns True if an entry
        was removed; False if no entry existed (idempotent)."""
        with self._lock:
            return self._sessions.pop(sid, None) is not None

    def size(self) -> int:
        with self._lock:
            return len(self._sessions)
