"""Per-HTTP-session correlation: each ServerSession instance gets its own
SessionState. Critical for shared-FastMCP-across-connections deployments,
which is the dominant pattern for the multi-tenant AI-server market the
SDK actually targets.

These tests simulate HTTP clients hitting the same FastMCP server by
manually setting the `mcp.server.lowlevel.server.request_ctx` ContextVar
to distinct stand-in session objects. Without the per-session fix, all
calls would map to the same shared 'stdio' session — meaning client A's
verify would unlock client B's protected tools.

Also covers the id-reuse safety property: when a session is garbage-
collected, its SessionStore entry must be evicted before any new session
can collide on the same memory address (CPython `id()`)."""

from __future__ import annotations

import gc
from types import SimpleNamespace

import pytest
from mcp.server.fastmcp import FastMCP
from mcp.server.lowlevel.server import request_ctx as _mcp_request_ctx

from fdkey import with_fdkey
from fdkey.guard import mark_verified
from fdkey.middleware import _FDKEY_ATTR, _resolve_session_id
from fdkey.session_store import SessionStore


@pytest.fixture(autouse=True)
def _isolate_request_ctx():
    """Each test starts with `request_ctx` unset and ends the same way,
    even if the test body raises. Without this, an exception between a
    `set()` and `reset()` would leak the contextvar value into the next
    test in the same async loop."""
    try:
        token = _mcp_request_ctx.set(None)
    except Exception:
        token = None
    yield
    if token is not None:
        try:
            _mcp_request_ctx.reset(token)
        except (LookupError, ValueError):
            pass


class _WeakSession:
    """Minimal weakref-able stand-in for `mcp.server.session.ServerSession`.
    `object()` doesn't support weakrefs; the real ServerSession does.
    Tests that exercise the WeakKeyDictionary path need this."""


def _fake_request_context(session_obj: object):
    """Build a minimal RequestContext stand-in. The resolver only reads
    `.session`; everything else is unused."""
    return SimpleNamespace(session=session_obj, request_id=1, meta=None)


def test_resolver_reads_distinct_sessions_from_mcp_context():
    """Two different `session` objects → two distinct stable keys."""
    store = SessionStore()
    session_a = _WeakSession()
    session_b = _WeakSession()

    token_a = _mcp_request_ctx.set(_fake_request_context(session_a))
    sid_a = _resolve_session_id(store)
    _mcp_request_ctx.reset(token_a)

    token_b = _mcp_request_ctx.set(_fake_request_context(session_b))
    sid_b = _resolve_session_id(store)
    _mcp_request_ctx.reset(token_b)

    assert sid_a != sid_b
    assert sid_a.startswith("mcp-")
    assert sid_b.startswith("mcp-")


def test_resolver_returns_stable_key_for_same_session():
    """Repeated calls with the same session must return the same key —
    otherwise per-session state never accumulates."""
    store = SessionStore()
    session = _WeakSession()
    token = _mcp_request_ctx.set(_fake_request_context(session))
    try:
        k1 = _resolve_session_id(store)
        k2 = _resolve_session_id(store)
        assert k1 == k2
    finally:
        _mcp_request_ctx.reset(token)


def test_resolver_falls_back_to_stdio_when_no_request_context():
    """Outside an active MCP request the resolver returns 'stdio'."""
    store = SessionStore()
    assert _resolve_session_id(store) == "stdio"


def test_session_state_evicted_when_session_is_gc_collected():
    """The id-reuse safety property: when a `ServerSession` is gc'd, its
    SessionStore entry MUST be evicted, so a new session that happens to
    get the same memory address (CPython id() reuse) cannot inherit the
    old verified state."""
    store = SessionStore()
    session = _WeakSession()
    token = _mcp_request_ctx.set(_fake_request_context(session))
    try:
        sid = _resolve_session_id(store)
        # Materialize the SessionState so it's actually in the store.
        s = store.get(sid)
        mark_verified(s)
        assert store.peek(sid) is not None
        assert store.peek(sid).verified is True
    finally:
        _mcp_request_ctx.reset(token)

    # Drop the only strong reference to the session and force GC.
    del session
    gc.collect()

    # The finalizer registered by `_SessionKeyTracker.key_for` must have
    # popped the entry. Anyone landing on this same memory address later
    # would have to mint a fresh SessionState (verified=False).
    assert store.peek(sid) is None


@pytest.mark.asyncio
async def test_two_clients_have_isolated_verification_state():
    """Client A solves a challenge → its session is verified. Client B
    (no challenge) tries the same protected tool → it MUST be blocked.
    Without the per-session correlation fix, B would inherit A's verified
    state via the shared 'stdio' session."""
    server = FastMCP("multi-tenant-server")
    with_fdkey(
        server,
        api_key="fdk_test",
        protect={"sensitive": {"policy": "once_per_session"}},
        vps_url="https://api.example.com",
    )

    calls_log: list[str] = []

    @server.tool(name="sensitive", description="protected")
    async def sensitive() -> str:
        calls_log.append("ran")
        return "ok"

    state = getattr(server, _FDKEY_ATTR)
    tool = server._tool_manager.get_tool("sensitive")

    session_a = _WeakSession()
    session_b = _WeakSession()

    # Client A: simulate an active MCP request, mark its session verified,
    # then call the protected tool.
    token_a = _mcp_request_ctx.set(_fake_request_context(session_a))
    sid_a = _resolve_session_id(state.store)
    mark_verified(state.store.get(sid_a))
    result_a = await tool.run({})
    _mcp_request_ctx.reset(token_a)

    # Client B: simulate a different MCP request — must NOT inherit A's
    # verification.
    token_b = _mcp_request_ctx.set(_fake_request_context(session_b))
    result_b = await tool.run({})
    _mcp_request_ctx.reset(token_b)

    text_a = _flatten(result_a)
    text_b = _flatten(result_b)
    assert text_a == "ok"
    assert "fdkey_verification_required" in text_b
    assert calls_log == ["ran"]


def _flatten(result) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        return " ".join(_flatten(x) for x in result)
    if hasattr(result, "text"):
        return result.text
    if isinstance(result, dict):
        if "text" in result:
            return str(result["text"])
        if "content" in result:
            return _flatten(result["content"])
    if isinstance(result, tuple):
        return " ".join(_flatten(x) for x in result)
    return str(result)
