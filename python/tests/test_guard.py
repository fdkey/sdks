"""Pure-function tests for guard.py — mirror the TS guard tests."""

import time

from fdkey.guard import (
    can_call,
    consume_policy,
    mark_verified,
    new_session,
)
from fdkey.types import (
    EachCallPolicy,
    EveryMinutesPolicy,
    OncePerSessionPolicy,
)


def test_new_session_starts_unverified():
    s = new_session()
    assert s.verified is False
    assert s.verified_at is None
    assert s.fresh_verification_available is False


def test_once_per_session_passes_after_verify():
    s = new_session()
    p = OncePerSessionPolicy()
    assert can_call(p, "x", s) is False
    mark_verified(s)
    assert can_call(p, "x", s) is True
    # Still passes after a tool call (no consumption).
    consume_policy(p, s)
    assert can_call(p, "x", s) is True


def test_each_call_consumes_ticket():
    s = new_session()
    p = EachCallPolicy()
    assert can_call(p, "x", s) is False
    mark_verified(s)
    assert can_call(p, "x", s) is True
    consume_policy(p, s)
    # After the first protected call, the ticket is gone.
    assert can_call(p, "x", s) is False


def test_every_minutes_window_expires():
    s = new_session()
    mark_verified(s)
    p = EveryMinutesPolicy(minutes=1)
    assert can_call(p, "x", s) is True
    # Force the verified_at into the past (>1 minute ago).
    s.verified_at = int(time.time() * 1000) - (61 * 1000)
    assert can_call(p, "x", s) is False


def test_every_minutes_requires_a_verify():
    s = new_session()
    p = EveryMinutesPolicy(minutes=5)
    assert can_call(p, "x", s) is False
