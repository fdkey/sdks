import type { SessionState } from './types.js';
import { newSession } from './guard.js';

/** Drop sessions that have been idle this long. One hour is comfortably
 *  longer than the default JWT lifetime (~5 min) plus typical agent
 *  retry/backoff windows, so an active session is never evicted while
 *  it could legitimately make another call. */
export const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/** Hard cap on the per-server session map. Hit this only on pathological
 *  burst traffic — even at this size the eviction is O(1) thanks to the
 *  JS Map's preserved-insertion-order semantics. */
export const MAX_SESSIONS = 10_000;

export interface SessionStore {
  /** Get-or-create the session for `id`, sliding the LRU position to the
   *  tail. Opportunistically evicts one stale (TTL-expired) entry per
   *  miss, and force-evicts the LRU when at the size cap. */
  get(id: string): SessionState;
  /** Number of currently-live sessions. Test-only convenience. */
  size(): number;
  /** Read-only access to a session without sliding LRU position. Returns
   *  undefined if the session doesn't exist. Used by `getFdkeyContext` so
   *  reading verification context doesn't extend a session's lifetime. */
  peek(id: string): SessionState | undefined;
}

/** Bounded session store. Memory is bounded by `maxSize` (the hard guarantee).
 *  Two eviction policies cooperate:
 *
 *    1. **TTL sweep on miss.** When a brand-new session arrives, the head
 *       of the map (always the LRU by insertion-order) is checked: if it
 *       has been idle longer than `idleTtlMs`, it's dropped. Sweep is
 *       O(1) per miss and only fires on misses — a busy session with
 *       many hits doesn't trigger it. This means stale entries can sit
 *       in the map longer than `idleTtlMs` if the server only ever sees
 *       hits; they're dropped opportunistically as new sessions arrive.
 *
 *    2. **LRU cap on insert.** When `sessions.size === maxSize`, the head
 *       (LRU) entry is force-dropped to make room — regardless of age.
 *       O(1) thanks to the JS Map's preserved-insertion-order semantics.
 *       This is the actual memory bound: maps NEVER exceed `maxSize`.
 *
 *  Net guarantee: long-lived MCP servers stay capped at `maxSize` entries
 *  (default 10k × ~200 bytes ≈ 2 MB) regardless of transport-level
 *  disconnect signals. Idle entries below the cap may linger past their
 *  TTL until pressure forces them out — that's acceptable because the
 *  cap itself is the safety property. */
export function createSessionStore(
  maxSize: number = MAX_SESSIONS,
  idleTtlMs: number = SESSION_IDLE_TTL_MS,
  now: () => number = Date.now,
): SessionStore {
  const sessions = new Map<string, SessionState>();

  return {
    get(id: string): SessionState {
      const t = now();
      const existing = sessions.get(id);
      if (existing) {
        // Slide to the tail of the LRU order: delete + re-insert is O(1).
        sessions.delete(id);
        existing.lastTouchedAt = t;
        sessions.set(id, existing);
        return existing;
      }
      // Miss → opportunistic TTL sweep of the head, then enforce the cap.
      const head = sessions.keys().next().value;
      if (head !== undefined) {
        const headSession = sessions.get(head);
        if (headSession && t - headSession.lastTouchedAt > idleTtlMs) {
          sessions.delete(head);
        }
      }
      if (sessions.size >= maxSize) {
        const lruKey = sessions.keys().next().value;
        if (lruKey !== undefined) sessions.delete(lruKey);
      }
      const fresh = newSession();
      fresh.lastTouchedAt = t;
      sessions.set(id, fresh);
      return fresh;
    },

    peek(id: string): SessionState | undefined {
      return sessions.get(id);
    },

    size(): number {
      return sessions.size;
    },
  };
}
