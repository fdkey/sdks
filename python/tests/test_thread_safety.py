"""Multi-threaded stress: SessionStore + _SessionKeyTracker must hold up
under concurrent access. Targets integrators wrapping FDKEY in a thread-
pool web framework (Flask, Quart with run_sync, asyncio.to_thread)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from fdkey.guard import mark_verified
from fdkey.session_store import SessionStore


def test_concurrent_get_returns_same_session_for_same_sid():
    """Many threads racing on the same `sid` must end up with the same
    SessionState — not different copies that overwrite each other in
    the dict, leaving some threads operating on garbage."""
    store = SessionStore()
    seen: list = []

    def race() -> None:
        s = store.get("shared-session")
        seen.append(id(s))

    with ThreadPoolExecutor(max_workers=32) as pool:
        for _ in range(500):
            pool.submit(race)

    # All threads must have observed the same SessionState identity.
    # Without the lock, `get()` would call `new_session()` per thread on a
    # cold miss and the dict overwrite would make most of them garbage —
    # the assertion would fail because `seen` would carry many distinct
    # ids.
    assert len(set(seen)) == 1, (
        f"Expected one identity, got {len(set(seen))}: "
        f"sample {list(set(seen))[:5]}"
    )
    assert store.size() == 1


def test_concurrent_distinct_sids_each_get_their_own_session():
    """N threads on N distinct sids must produce exactly N entries —
    no entries lost to lock contention or dict iteration races."""
    store = SessionStore(max_size=10_000)

    def make(i: int) -> str:
        s = store.get(f"sid-{i}")
        # Verify the session so we have something to inspect later.
        mark_verified(s)
        return f"sid-{i}"

    with ThreadPoolExecutor(max_workers=16) as pool:
        sids = list(pool.map(make, range(1_000)))

    assert store.size() == 1_000
    # Each one must still report verified — no mutation got lost.
    for sid in sids:
        s = store.peek(sid)
        assert s is not None
        assert s.verified is True


def test_concurrent_delete_during_get_is_safe():
    """Finalizer-driven delete() running concurrently with get() must not
    corrupt the dict. Both observe a consistent state."""
    store = SessionStore()

    # Pre-populate.
    for i in range(100):
        store.get(f"sid-{i}")

    def reader(i: int) -> None:
        store.peek(f"sid-{i % 100}")

    def deleter(i: int) -> None:
        store.delete(f"sid-{i % 100}")

    def writer(i: int) -> None:
        store.get(f"sid-{i % 100}")

    with ThreadPoolExecutor(max_workers=16) as pool:
        for i in range(2_000):
            if i % 3 == 0:
                pool.submit(deleter, i)
            elif i % 3 == 1:
                pool.submit(writer, i)
            else:
                pool.submit(reader, i)

    # If we made it here without an exception, the lock works. The exact
    # final size depends on the interleaving — what matters is no crash,
    # no KeyError from mid-iteration mutation.
    final_size = store.size()
    assert 0 <= final_size <= 100
