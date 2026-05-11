"""FDKEY middleware for FastMCP servers.

Mirrors the TypeScript SDK's `withFdkey()`. Injects two MCP tools into the
server (`fdkey_get_challenge`, `fdkey_submit_challenge`) and wraps the
tool registrar so any tool listed in `protect` is gated behind a
verification challenge until the connecting agent has solved one.

Public API:

    from mcp.server.fastmcp import FastMCP
    from fdkey import with_fdkey

    server = FastMCP("my-server")
    with_fdkey(
        server,
        api_key=os.environ["FDKEY_API_KEY"],
        protect={
            "sensitive_action": {"policy": "each_call"},
            "register": {"policy": "once_per_session"},
        },
    )

    @server.tool()
    def sensitive_action() -> str:
        # Reaches here only after the agent has solved a challenge.
        return "verified"
"""

from __future__ import annotations

import functools
import json
import threading
import uuid
import weakref
from contextvars import ContextVar
from typing import Any, Callable, Optional, Union

from mcp.types import ToolAnnotations

from .guard import (
    can_call,
    consume_policy,
    mark_verified,
)
from .jwt_verify import JwtVerifier, extract_score, extract_tier
from .session_store import SessionStore
from .types import (
    FdkeyContext,
    PolicyShorthand,
    Policy,
    SessionState,
    normalise_policy,
)
from .vps_client import VpsClient, VpsHttpError
from .well_known import WellKnownClient

# Probe the mcp package for the active-request ContextVar. The path moved
# between minor versions, so we try a couple of locations and fall back
# silently if neither is present (in which case all calls collapse to a
# single 'stdio' session — same as before this fix).
_mcp_request_ctx = None
try:
    from mcp.server.lowlevel.server import request_ctx as _mcp_request_ctx  # type: ignore[import-not-found,no-redef]
except ImportError:
    try:
        from mcp.shared.context import request_ctx as _mcp_request_ctx  # type: ignore[import-not-found,no-redef]
    except ImportError:
        _mcp_request_ctx = None


SDK_VERSION = "0.2.0"
DEFAULT_VPS_URL = "https://api.fdkey.com"

GET_CHALLENGE_TOOL = "fdkey_get_challenge"
SUBMIT_CHALLENGE_TOOL = "fdkey_submit_challenge"

GET_CHALLENGE_DESC = (
    "Request an AI identity verification challenge. Call this when a tool "
    "returns fdkey_verification_required, when asked to verify, or to verify "
    "proactively. There is a time limit on your answers."
)
SUBMIT_CHALLENGE_DESC = (
    "Submit answers to the active FDKEY challenge. On verified=true, retry "
    "the tool that was blocked. On verified=false, call fdkey_get_challenge "
    "to try again."
)

# Stable MCP tool annotations — kept invariant across puzzle types, answer
# formats, and timing config. Values describe what the tools DO at the
# protocol level, not what they serve. Clients (e.g. Claude Desktop) hash
# the tool surface for trust caching; stable annotations mean a puzzle
# change on the VPS doesn't churn the client-side trust fingerprint.
#
# Mirrors @fdkey/mcp 0.3.1 (TypeScript SDK).
#   readOnlyHint: False      — both tools modify server-side state
#                              (a session row / submission row on the VPS)
#   destructiveHint: False   — neither tool deletes/overwrites data
#   idempotentHint: False    — each get returns fresh puzzle; each submit
#                              is scored independently
#   openWorldHint: True      — both talk to the FDKEY VPS (external service)
_GET_CHALLENGE_ANNOTATIONS = ToolAnnotations(
    title="FDKEY: Get Verification Challenge",
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)
_SUBMIT_CHALLENGE_ANNOTATIONS = ToolAnnotations(
    title="FDKEY: Submit Verification Answers",
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)


# Each FastMCP server gets its own session map and config bag, hung off the
# server object via a sentinel attribute. We avoid a global registry so
# multiple servers in one process don't share state.
_FDKEY_ATTR = "_fdkey_state"

# Per-handler-call session id. The MCP Python SDK threads request state
# through `mcp.server.lowlevel.server.request_ctx` (a ContextVar). We
# resolve the active session via `resolve_session_id()` below. This
# ContextVar is a manual override / test seam: if it's set, it wins; if
# not, the resolver reads the mcp request_ctx and derives a stable key
# from `id(session)`. This is the difference between every HTTP request
# sharing one global "stdio" session (the bug) vs. each client connection
# getting its own SessionState (the fix).
_active_session_id: ContextVar[Optional[str]] = ContextVar(
    "fdkey_active_session_id", default=None
)


class _SessionKeyTracker:
    """Maps live `ServerSession` objects to stable per-process keys.

    Why this exists: the obvious approach — `f"mcp-{id(session)}"` — is
    UNSAFE because Python's `id()` is the memory address. After a
    `ServerSession` is gc'd, that address is free for reuse by the
    allocator. A long-lived SessionStore entry (TTL is 1h) keyed on the
    old address could be resurrected for a new, unrelated session — the
    classic cross-tenant verification leak.

    Mechanism:
      * `WeakKeyDictionary[ServerSession, str]` maps each live session
        to a fresh UUID we generate on first sight. Entries vanish
        automatically when the session is gc'd.
      * `weakref.finalize(session, ...)` evicts the corresponding
        SessionStore entry the moment the session is collected — closes
        the id-reuse window without waiting for TTL.

    Thread safety: a `threading.Lock` guards the get-or-create critical
    section so multi-threaded callers (e.g. integrators wrapping the SDK
    in a thread-pool web framework) can't both miss the cache, both
    generate a UUID, and end up with two `SessionStore` entries for one
    `ServerSession`. The lock is uncontended in standard asyncio
    deployments (~100 ns), so the cost is invisible against real
    workloads.
    """

    def __init__(self) -> None:
        self._keys: "weakref.WeakKeyDictionary[Any, str]" = (
            weakref.WeakKeyDictionary()
        )
        self._lock = threading.Lock()

    def key_for(self, session: Any, store: SessionStore) -> str:
        with self._lock:
            existing = self._keys.get(session)
            if existing is not None:
                return existing
            key = f"mcp-{uuid.uuid4().hex}"
            try:
                self._keys[session] = key
            except TypeError:
                # Session object doesn't support weakrefs (e.g. a test
                # stub using a basic object()); fall back to id() with
                # the original caveat. Real ServerSession instances
                # support weakrefs so this branch is unreachable in
                # production.
                return f"mcp-id-{id(session)}"
            # When the session is gc'd, evict the SessionStore entry.
            # `store_ref` is a weakref so the finalizer doesn't keep
            # the store alive past its natural lifetime.
            store_ref = weakref.ref(store)

            def _on_gc(k: str = key) -> None:
                s = store_ref()
                if s is not None:
                    s.delete(k)

            weakref.finalize(session, _on_gc)
            return key


# Module-level tracker. One per process is correct: ServerSession objects
# can be uniquely identified across all FastMCP servers in the process
# because two distinct ServerSession instances never share identity.
_session_key_tracker = _SessionKeyTracker()


def _resolve_session_id(store: SessionStore) -> str:
    """Best-effort active-session detection. Returns a stable per-session
    string key. See `_SessionKeyTracker` for the id-reuse-safe mechanism.

    Priority:
      1. The legacy `_active_session_id` override — set by tests or by
         an integrator who manually threads session info.
      2. The mcp package's `request_ctx` ContextVar (set automatically
         during request handling by the low-level Server). Reads
         `rc.session` and looks it up in the WeakKeyDictionary tracker.
      3. The literal `'stdio'` fallback — reached when no MCP request
         is active (e.g. integrator code calling `get_fdkey_context()`
         outside a tool handler), or when SDK is used in stdio mode
         (one session for the life of the process).
    """
    override = _active_session_id.get()
    if override:
        return override
    if _mcp_request_ctx is not None:
        try:
            rc = _mcp_request_ctx.get(None)
        except LookupError:
            rc = None
        if rc is not None:
            session = getattr(rc, "session", None)
            if session is not None:
                return _session_key_tracker.key_for(session, store)
    return "stdio"


class _FdkeyState:
    """Bundle of per-server caches & config attached to a FastMCP instance."""

    def __init__(
        self,
        api_key: str,
        protect: dict[str, Policy],
        difficulty: str,
        on_fail: str,
        on_vps_error: str,
        inline_challenge: bool,
        vps_url: str,
        tags: Optional[dict[str, str]],
        server_name: Optional[str],
        server_version: Optional[str],
    ) -> None:
        self.protect = protect
        self.on_fail = on_fail
        self.on_vps_error = on_vps_error
        self.inline_challenge = inline_challenge
        self.tags = tags
        self.integrator_meta = {
            "server_name": server_name,
            "server_version": server_version,
            "sdk_version": SDK_VERSION,
        }
        self.well_known = WellKnownClient(vps_url)
        self.vps_client = VpsClient(vps_url, api_key, difficulty)
        self.jwt_verifier = JwtVerifier(self.well_known)
        # Bounded per-server session store — see session_store.py for the
        # full TTL + LRU eviction contract. Long-lived shared FastMCP
        # servers don't leak session memory regardless of transport.
        self.store = SessionStore()

    def session_for(self, sid: Optional[str]) -> SessionState:
        return self.store.get(sid or "stdio")


def with_fdkey(
    server: Any,
    *,
    api_key: str,
    protect: Optional[dict[str, dict[str, Any]]] = None,
    difficulty: str = "medium",
    on_fail: str = "block",
    on_vps_error: str = "allow",
    inline_challenge: bool = False,
    vps_url: Optional[str] = None,
    tags: Optional[dict[str, str]] = None,
) -> Any:
    """Wrap a FastMCP server with FDKEY verification middleware.

    Returns the same server instance (mutated) for chaining convenience.
    See module docstring for usage."""

    normalised: dict[str, Policy] = {}
    for name, entry in (protect or {}).items():
        normalised[name] = normalise_policy(entry.get("policy", entry))

    server_name, server_version = _read_server_info(server)
    state = _FdkeyState(
        api_key=api_key,
        protect=normalised,
        difficulty=difficulty,
        on_fail=on_fail,
        on_vps_error=on_vps_error,
        inline_challenge=inline_challenge,
        vps_url=vps_url or DEFAULT_VPS_URL,
        tags=tags,
        server_name=server_name,
        server_version=server_version,
    )
    setattr(server, _FDKEY_ATTR, state)

    _register_fdkey_tools(server, state)
    _wrap_tool_registrar(server, state)
    return server


def get_fdkey_context(
    server: Any,
    extra_or_session_id: Union[dict[str, Any], str, None],
) -> Optional[FdkeyContext]:
    """Read the verification context for the current session from inside an
    integrator tool handler. Pass either the FastMCP context object (or any
    dict carrying `session_id`) or a session id string."""
    state: Optional[_FdkeyState] = getattr(server, _FDKEY_ATTR, None)
    if state is None:
        return None
    if isinstance(extra_or_session_id, str):
        sid = extra_or_session_id
    elif isinstance(extra_or_session_id, dict):
        sid = (
            extra_or_session_id.get("session_id")
            or extra_or_session_id.get("sessionId")
            or "stdio"
        )
    else:
        sid = _resolve_session_id(state.store)
    # peek() does NOT slide the LRU position — querying context shouldn't
    # extend a session's lifetime; only actual tool calls do that.
    s = state.store.peek(sid)
    if s is None:
        return FdkeyContext(
            verified=False,
            verified_at=None,
            score=None,
            tier=None,
            claims=None,
        )
    return FdkeyContext(
        verified=s.verified,
        verified_at=s.verified_at,
        score=extract_score(s.last_claims),
        tier=extract_tier(s.last_claims),
        claims=s.last_claims,
    )


# -------- internals --------


def _read_server_info(server: Any) -> tuple[Optional[str], Optional[str]]:
    """Best-effort read of server name/version. FastMCP changes this surface
    over time — fall through gracefully if not found."""
    name = getattr(server, "name", None) or getattr(server, "_name", None)
    version = getattr(server, "version", None) or getattr(server, "_version", None)
    if not name:
        info = getattr(server, "_server_info", None)
        if isinstance(info, dict):
            name = info.get("name")
            version = info.get("version")
    return name, version


def _register_fdkey_tools(server: Any, state: _FdkeyState) -> None:
    """Add the two FDKEY tools to the server. Uses whichever registration
    path FastMCP currently exposes (`add_tool` or `tool` decorator).

    Annotations are passed only when the underlying API accepts them — older
    FastMCP releases lack the `annotations` keyword on `add_tool` / `tool`,
    so we try with-annotations first and fall back silently. This keeps the
    SDK compatible with `mcp>=1.0.0` while opportunistically surfacing trust
    hints on newer runtimes that support them."""

    def _try(fn: Callable[..., Any], with_annotations: dict[str, Any], without: dict[str, Any]) -> None:
        try:
            fn(**with_annotations)
        except TypeError:
            # Older FastMCP — no `annotations` keyword. Retry without.
            fn(**without)

    add_tool = getattr(server, "add_tool", None)
    if callable(add_tool):
        _try(
            add_tool,
            with_annotations={
                "fn": _make_get_challenge_handler(state),
                "name": GET_CHALLENGE_TOOL,
                "description": GET_CHALLENGE_DESC,
                "annotations": _GET_CHALLENGE_ANNOTATIONS,
            },
            without={
                "fn": _make_get_challenge_handler(state),
                "name": GET_CHALLENGE_TOOL,
                "description": GET_CHALLENGE_DESC,
            },
        )
        _try(
            add_tool,
            with_annotations={
                "fn": _make_submit_handler(state),
                "name": SUBMIT_CHALLENGE_TOOL,
                "description": SUBMIT_CHALLENGE_DESC,
                "annotations": _SUBMIT_CHALLENGE_ANNOTATIONS,
            },
            without={
                "fn": _make_submit_handler(state),
                "name": SUBMIT_CHALLENGE_TOOL,
                "description": SUBMIT_CHALLENGE_DESC,
            },
        )
        return

    tool = getattr(server, "tool", None)
    if callable(tool):
        try:
            tool(
                name=GET_CHALLENGE_TOOL,
                description=GET_CHALLENGE_DESC,
                annotations=_GET_CHALLENGE_ANNOTATIONS,
            )(_make_get_challenge_handler(state))
            tool(
                name=SUBMIT_CHALLENGE_TOOL,
                description=SUBMIT_CHALLENGE_DESC,
                annotations=_SUBMIT_CHALLENGE_ANNOTATIONS,
            )(_make_submit_handler(state))
        except TypeError:
            tool(name=GET_CHALLENGE_TOOL, description=GET_CHALLENGE_DESC)(
                _make_get_challenge_handler(state)
            )
            tool(name=SUBMIT_CHALLENGE_TOOL, description=SUBMIT_CHALLENGE_DESC)(
                _make_submit_handler(state)
            )
        return
    raise RuntimeError(
        "fdkey: server has neither add_tool nor tool — is this a FastMCP server?"
    )


def _wrap_tool_registrar(server: Any, state: _FdkeyState) -> None:
    """Monkey-patch `server.add_tool` (and `server.tool`) so future tool
    registrations matching `state.protect` are gated. Tools not in the
    protect map are passed through untouched."""

    original_add = getattr(server, "add_tool", None)
    if callable(original_add):
        def add_tool(fn, *args, name=None, description=None, **kwargs):
            n = name or getattr(fn, "__name__", None)
            if n in state.protect and n not in (GET_CHALLENGE_TOOL, SUBMIT_CHALLENGE_TOOL):
                fn = _wrap_handler(fn, n, state.protect[n], state)
            return original_add(fn, *args, name=name, description=description, **kwargs)
        server.add_tool = add_tool

    original_tool = getattr(server, "tool", None)
    if callable(original_tool):
        def tool(*tool_args, **tool_kwargs):
            decorator = original_tool(*tool_args, **tool_kwargs)

            def inner(fn):
                n = tool_kwargs.get("name") or getattr(fn, "__name__", None)
                if n in state.protect and n not in (GET_CHALLENGE_TOOL, SUBMIT_CHALLENGE_TOOL):
                    fn = _wrap_handler(fn, n, state.protect[n], state)
                return decorator(fn)
            return inner
        server.tool = tool


def _wrap_handler(
    fn: Callable[..., Any], tool_name: str, policy: Policy, state: _FdkeyState
) -> Callable[..., Any]:
    """Returns a coroutine wrapper that gates `fn` behind a verified session.

    `functools.wraps(fn)` is critical here: FastMCP introspects the wrapped
    handler with `inspect.signature(...)` to derive a Pydantic schema for
    the tool's input arguments. Without `wraps`, the wrapper's `*args,
    **kwargs` signature would surface as required tool inputs and every
    call would fail Pydantic validation. `wraps` sets `__wrapped__` so
    `inspect.signature()` follows it back to the original function's
    parameter list."""

    import asyncio

    is_coro = asyncio.iscoroutinefunction(fn)

    @functools.wraps(fn)
    async def gated(*args: Any, **kwargs: Any) -> Any:
        sid = _resolve_session_id(state.store)
        session = state.session_for(sid)
        if can_call(policy, tool_name, session):
            result = await fn(*args, **kwargs) if is_coro else fn(*args, **kwargs)
            consume_policy(policy, session)
            return result

        if state.inline_challenge:
            try:
                challenge = await state.vps_client.fetch_challenge(_meta_for(state))
                session.pending_challenge_id = challenge.challenge_id
                return _result_text(
                    "fdkey_verification_required. Solve the challenge below then "
                    f"call {SUBMIT_CHALLENGE_TOOL} with your answers, then retry "
                    "this tool.\n\n" + _challenge_text(challenge)
                )
            except Exception:
                if state.on_vps_error == "allow":
                    return await fn(*args, **kwargs) if is_coro else fn(*args, **kwargs)
                return _error_text(
                    "fdkey_service_unavailable: verification service is "
                    "temporarily unreachable. Retry in a few seconds."
                )

        return _error_text(
            f"fdkey_verification_required. Call {GET_CHALLENGE_TOOL} to start "
            f"verification, then {SUBMIT_CHALLENGE_TOOL} with your answers, "
            "then retry this tool."
        )

    return gated


def _make_get_challenge_handler(state: _FdkeyState) -> Callable[..., Any]:
    async def handler() -> Any:
        sid = _resolve_session_id(state.store)
        session = state.session_for(sid)
        try:
            challenge = await state.vps_client.fetch_challenge(_meta_for(state))
            session.pending_challenge_id = challenge.challenge_id
            return _result_text(_challenge_text(challenge))
        except Exception as err:
            return _error_text(f"fdkey_service_unavailable: {err}")

    handler.__name__ = GET_CHALLENGE_TOOL
    return handler


def _make_submit_handler(state: _FdkeyState) -> Callable[..., Any]:
    async def handler(answers: dict[str, Any]) -> Any:
        sid = _resolve_session_id(state.store)
        session = state.session_for(sid)
        if not session.pending_challenge_id:
            return _result_text(
                json.dumps(
                    {
                        "verified": False,
                        "error": "no_active_challenge",
                        "message": (
                            f"No active challenge. Call {GET_CHALLENGE_TOOL} first."
                        ),
                    }
                )
            )

        try:
            result = await state.vps_client.submit_answers(
                session.pending_challenge_id, answers
            )
        except VpsHttpError as err:
            session.pending_challenge_id = None
            err_code = err.body.get("error") if isinstance(err.body, dict) else None
            if err_code == "challenge_expired":
                return _result_text(
                    json.dumps(
                        {
                            "verified": False,
                            "error": "challenge_expired",
                            "message": (
                                f"Challenge expired. Call {GET_CHALLENGE_TOOL} "
                                "to start a new one."
                            ),
                        }
                    )
                )
            if 400 <= err.status < 500:
                # Distinguish agent-facing 4xx (the agent's submission is in a
                # bad state — expired, replayed, wrong session) from
                # client-bug 4xx (the SDK sent a malformed body —
                # invalid_body, 422, etc.).
                #
                # Agent-facing 4xx → on_fail decides. Ordinary verification
                # failures.
                # Client-bug 4xx → ALWAYS surface loudly. on_fail='allow'
                # must not paper over a malformed-submit-body integrator/SDK
                # bug. Per the README fail-open contract: "If the FDKEY
                # scoring service is unreachable, the SDKs default to
                # fail-open." A 4xx response is the VPS working correctly,
                # not an outage.
                AGENT_FACING_4XX = {
                    "challenge_expired", "already_submitted", "wrong_user",
                    "invalid_challenge", "challenge_not_found",
                }
                if err_code in AGENT_FACING_4XX:
                    if state.on_fail == "allow":
                        mark_verified(session)
                        return _result_text(json.dumps({"verified": True, "message": "Verification skipped per server configuration."}))
                    return _result_text(
                        json.dumps({"verified": False, "error": err_code or "verification_failed"})
                    )
                # Client-bug 4xx — always loud, regardless of on_fail/on_vps_error.
                return _error_text(
                    f"fdkey_unexpected_4xx: FDKEY VPS returned HTTP {err.status} "
                    f"{err_code or ''}. This is an integrator/SDK bug, not a VPS "
                    f"outage. Check the wire format. ({err})"
                )
            if state.on_vps_error == "allow":
                mark_verified(session)
                return _result_text(json.dumps({"verified": True, "message": "VPS unreachable — access allowed."}))
            return _error_text(f"fdkey_service_unavailable: {err}")
        except Exception as err:
            session.pending_challenge_id = None
            if state.on_vps_error == "allow":
                mark_verified(session)
                return _result_text(json.dumps({"verified": True}))
            return _error_text(f"fdkey_service_unavailable: {err}")

        session.pending_challenge_id = None

        if result.verified and result.jwt:
            claims = await state.jwt_verifier.verify(result.jwt)
            if claims is None:
                if state.on_fail == "allow":
                    mark_verified(session)
                    return _result_text(json.dumps({"verified": True, "message": "Verification passed (JWT validation skipped)."}))
                return _result_text(json.dumps({"verified": False, "message": "Verification failed: invalid JWT"}))
            session.last_claims = claims
            mark_verified(session)
            return _result_text(json.dumps({"verified": True, "message": "Verification passed. You can now access protected tools."}))

        if state.on_fail == "allow":
            mark_verified(session)
            return _result_text(json.dumps({"verified": True, "message": "Verification failed but access allowed."}))
        return _result_text(json.dumps({"verified": False, "message": f"Verification failed. Call {GET_CHALLENGE_TOOL} to try again."}))

    handler.__name__ = SUBMIT_CHALLENGE_TOOL
    return handler


def _meta_for(state: _FdkeyState) -> dict[str, Any]:
    """Per-call metadata bundle. The Python SDK forwards the integrator
    block + tags only; agent identification (clientInfo / protocol_version)
    capture from FastMCP requires hooks that vary by mcp version and is
    intentionally deferred. The VPS-side wire schema marks `agent`
    optional, so omitting the key entirely is correct — `vps_client.py`
    drops blocks whose values are all None."""
    meta: dict[str, Any] = {"integrator": state.integrator_meta}
    if state.tags:
        meta["tags"] = state.tags
    return meta


def _challenge_payload(c: Any) -> dict[str, Any]:
    """Fallback dict-shaped payload — used when the VPS doesn't supply a
    pre-rendered directive (`mcp_response_text`). Stays puzzle-agnostic:
    `puzzles` and `example_submission` are pass-through opaque blobs."""
    return {
        "expires_in_seconds": c.expires_in_seconds
        or _expires_in_seconds(c.expires_at),
        "difficulty": c.difficulty,
        "types_served": c.types_served,
        "header": c.header,
        "puzzles": c.puzzles,
        "example_submission": c.example_submission,
        "footer": c.footer,
    }


def _challenge_text(c: Any) -> str:
    """Return the agent-facing text for a challenge response.

    Canonical path: pass through the VPS-rendered `mcp_response_text`
    verbatim. This keeps all agent-facing prose (puzzles, instructions,
    examples, timing framing) in the VPS — prompt iteration is a VPS-
    deploy only, no SDK release.

    Fallback (legacy VPS without `mcp_response_text`): JSON-stringify the
    `_challenge_payload` dict. The agent still sees everything (puzzles,
    example_submission, header, footer) but in a less readable shape."""
    if c.mcp_response_text:
        return c.mcp_response_text
    return json.dumps(_challenge_payload(c))


def _expires_in_seconds(expires_at_iso: str) -> int:
    from datetime import datetime, timezone

    try:
        # Python 3.11+ handles trailing Z; earlier needs replacement.
        iso = expires_at_iso.replace("Z", "+00:00")
        ms = (datetime.fromisoformat(iso).astimezone(timezone.utc).timestamp() * 1000) - (
            __import__("time").time() * 1000
        )
        return max(0, int(ms // 1000))
    except Exception:
        return 0


def _result_text(text: str) -> Any:
    """FastMCP results: a plain string is auto-wrapped into a TextContent
    block. We return strings directly to stay compatible across mcp
    package versions (older versions used dicts; newer auto-shape)."""
    return text


def _error_text(text: str) -> Any:
    # Convention: caller sees an isError-style payload. For simplicity we
    # return a string prefix the agent recognises — the FastMCP layer
    # decides how to surface it.
    return text
