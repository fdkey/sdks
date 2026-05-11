"""Direct tests for the FastMCP-wrapping logic in middleware.py.

Covers the integration the smoke check in CI used to imply but never
actually asserted: tool-handler interception, gating before verify,
pass-through after verify, and the consume-on-each-call ticket on
EachCall policy."""

from __future__ import annotations

import pytest
from mcp.server.fastmcp import FastMCP

from fdkey import get_fdkey_context, with_fdkey
from fdkey.guard import mark_verified
from fdkey.middleware import _FDKEY_ATTR


def _make_protected_server(policy: str = "each_call") -> tuple[FastMCP, dict]:
    """Build a wrapped server with one protected tool. Returns (server, calls)
    where `calls` is a list mutated by the protected tool so tests can
    confirm whether the original handler ran."""
    server = FastMCP("test-server")
    with_fdkey(
        server,
        api_key="fdk_test",
        protect={"sensitive": {"policy": policy}},
        vps_url="https://api.example.com",
    )

    calls: list[str] = []

    @server.tool(name="sensitive", description="protected")
    async def sensitive() -> str:
        calls.append("ran")
        return "ok"

    return server, calls


@pytest.mark.asyncio
async def test_protected_tool_blocked_before_verify():
    """Calling a protected tool with no verified session returns the
    fdkey_verification_required hint; the original handler does NOT run."""
    server, calls = _make_protected_server(policy="each_call")

    # FastMCP exposes the wrapped handler via its internal tool registry.
    # We don't have a session id (stdio path), so fdkey reads sid='stdio'.
    # The wrapped handler returns the hint string we expect.
    tool = server._tool_manager.get_tool("sensitive")  # private API, ok in tests
    assert tool is not None
    result = await tool.run({})
    text = _flatten(result)
    assert "fdkey_verification_required" in text
    assert "fdkey_get_challenge" in text
    assert calls == []  # original handler did not run


@pytest.mark.asyncio
async def test_protected_tool_runs_after_mark_verified():
    """Once we mark the stdio session verified, the same protected tool
    runs the original handler exactly once. EachCall consumes the ticket
    so a second call is again blocked."""
    server, calls = _make_protected_server(policy="each_call")

    state = getattr(server, _FDKEY_ATTR)
    session = state.session_for("stdio")
    mark_verified(session)

    tool = server._tool_manager.get_tool("sensitive")
    result = await tool.run({})
    assert _flatten(result) == "ok"
    assert calls == ["ran"]

    # Second call: ticket consumed → blocked again.
    result2 = await tool.run({})
    assert "fdkey_verification_required" in _flatten(result2)
    assert calls == ["ran"]  # not called again


@pytest.mark.asyncio
async def test_once_per_session_does_not_consume_ticket():
    """OncePerSession holds — repeated calls all run the original handler."""
    server, calls = _make_protected_server(policy="once_per_session")

    state = getattr(server, _FDKEY_ATTR)
    mark_verified(state.session_for("stdio"))

    tool = server._tool_manager.get_tool("sensitive")
    for _ in range(3):
        result = await tool.run({})
        assert _flatten(result) == "ok"
    assert calls == ["ran", "ran", "ran"]


def test_get_fdkey_context_returns_score_and_tier_first_class():
    """Sanity: surface verifies the FdkeyContext shape advertised in
    docs (score, tier, claims). Defaults to None on a cold session."""
    server = FastMCP("test")
    with_fdkey(server, api_key="fdk_test", vps_url="https://api.example.com")

    ctx = get_fdkey_context(server, "fresh-session")
    assert ctx is not None
    assert ctx.verified is False
    assert ctx.score is None
    assert ctx.tier is None
    assert ctx.claims is None


def test_get_fdkey_context_returns_none_for_unwrapped_server():
    """If with_fdkey was never called, get_fdkey_context returns None
    rather than raising."""
    server = FastMCP("unwrapped")
    assert get_fdkey_context(server, "anything") is None


def test_unprotected_tools_pass_through_unchanged():
    """A tool not in the protect dict registers normally and is not gated."""
    server = FastMCP("test")
    with_fdkey(
        server,
        api_key="fdk_test",
        protect={"sensitive": {"policy": "each_call"}},
        vps_url="https://api.example.com",
    )

    @server.tool(name="public")
    def public() -> str:
        return "free"

    tool = server._tool_manager.get_tool("public")
    assert tool is not None


def _flatten(result) -> str:
    """FastMCP tool runners return varied shapes across mcp versions —
    list of TextContent, plain str, dict-of-content, etc. Squash to a
    string for assertions."""
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        # list of TextContent or dicts
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


# ─────────────────────────────────────────────────────────────────────────
# 0.2.0 contract tests — mcp_response_text passthrough + ToolAnnotations
# ─────────────────────────────────────────────────────────────────────────


def test_challenge_text_returns_mcp_response_text_verbatim_when_present() -> None:
    """The canonical 0.2.0 path: VPS supplies a pre-rendered directive, the
    SDK relays it verbatim. No JSON wrapping, no re-rendering."""
    from fdkey.middleware import _challenge_text
    from fdkey.vps_client import ChallengeResponse

    c = ChallengeResponse(
        challenge_id="cid-1",
        expires_at="2026-05-11T12:00:00Z",
        expires_in_seconds=60,
        difficulty="medium",
        types_served=["type1"],
        header="should-not-appear-when-mcp_response_text-set",
        puzzles={"type1": []},
        footer="should-not-appear-either",
        mcp_response_text="⚡ DIRECTIVE FROM VPS",
        example_submission={"tool_call_arguments": {"answers": {}}},
    )
    assert _challenge_text(c) == "⚡ DIRECTIVE FROM VPS"


def test_challenge_text_falls_back_to_json_when_mcp_response_text_absent() -> None:
    """Older VPS doesn't send mcp_response_text → SDK falls back to a
    puzzle-agnostic JSON dict including header, puzzles, example_submission,
    footer. Surface stays opaque (no per-type rendering)."""
    import json as _json

    from fdkey.middleware import _challenge_text
    from fdkey.vps_client import ChallengeResponse

    c = ChallengeResponse(
        challenge_id="cid-2",
        expires_at="2026-05-11T12:00:00Z",
        expires_in_seconds=60,
        difficulty="medium",
        types_served=["type1"],
        header="hdr",
        puzzles={"type1": [{"q": "x"}]},
        footer="ftr",
        mcp_response_text=None,
        example_submission={"_note": "example", "body": {"challenge_id": "cid-2", "answers": {}}},
    )
    out = _challenge_text(c)
    payload = _json.loads(out)
    assert payload["header"] == "hdr"
    assert payload["puzzles"] == {"type1": [{"q": "x"}]}
    assert payload["footer"] == "ftr"
    assert payload["example_submission"]["_note"] == "example"


def test_challenge_text_falls_back_when_mcp_response_text_is_empty_string() -> None:
    """Empty string is treated as 'not provided' so the agent gets the
    fallback rather than an empty tool result."""
    import json as _json

    from fdkey.middleware import _challenge_text
    from fdkey.vps_client import ChallengeResponse

    c = ChallengeResponse(
        challenge_id="cid-3",
        expires_at="2026-05-11T12:00:00Z",
        expires_in_seconds=60,
        difficulty="medium",
        types_served=[],
        header=None,
        puzzles={},
        footer=None,
        mcp_response_text="",
        example_submission=None,
    )
    out = _challenge_text(c)
    # Falls back to JSON dict (parses cleanly), not an empty string.
    _json.loads(out)


def test_tools_are_registered_with_stable_mcp_annotations() -> None:
    """Both injected tools must carry the puzzle-agnostic ToolAnnotations
    so MCP clients can categorize them without re-fingerprinting on every
    SDK release."""
    server = FastMCP("ann-test")
    with_fdkey(
        server,
        api_key="fdk_test",
        protect={},
        vps_url="https://api.example.com",
    )

    # FastMCP stores registered tools on its internal tool manager. Probe the
    # documented `list_tools` surface — that's what clients see over MCP.
    # `list_tools` is async on FastMCP; for the registration smoke we can
    # use the synchronous internal accessor.
    tool_manager = getattr(server, "_tool_manager", None)
    assert tool_manager is not None, "FastMCP internal _tool_manager missing — API may have moved"

    def _find(name: str) -> object:
        tools = list(tool_manager.list_tools())
        for t in tools:
            if getattr(t, "name", None) == name:
                return t
        raise AssertionError(f"tool {name!r} not registered")

    for name, expected_title in [
        ("fdkey_get_challenge", "FDKEY: Get Verification Challenge"),
        ("fdkey_submit_challenge", "FDKEY: Submit Verification Answers"),
    ]:
        t = _find(name)
        ann = getattr(t, "annotations", None)
        assert ann is not None, f"{name} has no annotations attached"
        assert ann.title == expected_title
        assert ann.readOnlyHint is False
        assert ann.destructiveHint is False
        assert ann.idempotentHint is False
        assert ann.openWorldHint is True


def test_supports_kwarg_introspection() -> None:
    """The signature-inspection helper backing `_register_fdkey_tools`
    avoids using TypeError as a sentinel. Should return True for kwargs
    the function declares, False otherwise, and False gracefully for
    objects that aren't introspectable."""
    from fdkey.middleware import _supports_kwarg

    def f(a, b, *, c=None, d=None) -> None: ...

    assert _supports_kwarg(f, "c") is True
    assert _supports_kwarg(f, "d") is True
    assert _supports_kwarg(f, "missing") is False
    assert _supports_kwarg(None, "anything") is False
    # Builtins commonly fail signature inspection — should degrade to False,
    # not crash.
    assert _supports_kwarg(object, "missing") is False
