"""Per-session verification policy logic. Pure functions — no I/O,
no state outside the SessionState argument. Mirrors guard.ts."""

from __future__ import annotations

import time

from .types import (
    EachCallPolicy,
    EveryMinutesPolicy,
    OncePerSessionPolicy,
    Policy,
    SessionState,
)


def new_session() -> SessionState:
    """A fresh, never-verified session."""
    return SessionState()


def can_call(policy: Policy, _tool_name: str, session: SessionState) -> bool:
    """True iff the session's verification state satisfies the policy.

      once_per_session: pass if the session has ever been verified.
      each_call:        pass only if there is an unconsumed fresh ticket.
      every_minutes: N: pass while (now - verified_at) < N minutes — the
                        timer does NOT extend on calls; it expires N
                        minutes after the puzzle was solved.
    """
    if isinstance(policy, OncePerSessionPolicy):
        return session.verified
    if isinstance(policy, EachCallPolicy):
        return session.verified and session.fresh_verification_available
    if isinstance(policy, EveryMinutesPolicy):
        if session.verified_at is None:
            return False
        return _now_ms() - session.verified_at < policy.minutes * 60 * 1000
    raise ValueError(f"Unknown policy: {policy!r}")


def mark_verified(session: SessionState) -> None:
    """Called only when the submit tool succeeds. Replenishes session state."""
    session.verified = True
    session.verified_at = _now_ms()
    session.fresh_verification_available = True


def consume_policy(policy: Policy, session: SessionState) -> None:
    """Called after a protected tool call completes. Consumes the
    fresh-verification ticket for each_call policies; no-op for the others."""
    if isinstance(policy, EachCallPolicy):
        session.fresh_verification_available = False


def _now_ms() -> int:
    return int(time.time() * 1000)
