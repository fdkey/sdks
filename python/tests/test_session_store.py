"""Bounded SessionStore — TTL + LRU cap, mirrors the TS test suite."""

from fdkey.session_store import SessionStore


def test_lru_evicts_oldest_when_size_cap_reached():
    store = SessionStore(max_size=3, idle_ttl_ms=1_000_000)
    store.get("a")
    store.get("b")
    store.get("c")
    assert store.size() == 3
    assert store.peek("a") is not None

    # Insert a 4th — hard-cap evicts the LRU ('a').
    store.get("d")
    assert store.size() == 3
    assert store.peek("a") is None
    assert store.peek("b") is not None
    assert store.peek("c") is not None
    assert store.peek("d") is not None


def test_touching_session_slides_lru_position():
    store = SessionStore(max_size=3, idle_ttl_ms=1_000_000)
    store.get("a")
    store.get("b")
    store.get("c")
    # Touch 'a' — now 'b' is the LRU.
    store.get("a")
    store.get("d")
    assert store.peek("a") is not None
    assert store.peek("b") is None
    assert store.peek("c") is not None
    assert store.peek("d") is not None


def test_ttl_evicts_idle_session_on_next_miss():
    clock = [1_000_000]
    store = SessionStore(max_size=100, idle_ttl_ms=60_000, now_ms=lambda: clock[0])
    store.get("idle")
    assert store.peek("idle") is not None

    # Fast-forward past the idle TTL.
    clock[0] += 60_001
    # Trigger a miss — head ('idle') is older than TTL → swept.
    store.get("fresh")
    assert store.peek("idle") is None
    assert store.peek("fresh") is not None


def test_peek_does_not_slide_lru_position():
    clock = [1_000_000]
    store = SessionStore(max_size=3, idle_ttl_ms=60_000, now_ms=lambda: clock[0])
    store.get("a")
    store.get("b")
    store.peek("a")  # MUST NOT touch
    store.get("c")
    store.get("d")
    # 'a' should still be evicted as the LRU even though we peeked it.
    assert store.peek("a") is None
    assert store.peek("b") is not None


def test_size_tracks_active_sessions():
    store = SessionStore(max_size=10, idle_ttl_ms=60_000)
    assert store.size() == 0
    for i in range(5):
        store.get(f"s{i}")
    assert store.size() == 5
    # Re-touching doesn't grow.
    store.get("s0")
    assert store.size() == 5
