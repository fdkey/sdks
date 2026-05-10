"""Public types for the fdkey package — config, policies, session state, context."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

PolicyShorthand = Literal["once_per_session", "each_call"]


@dataclass(frozen=True)
class OncePerSessionPolicy:
    type: Literal["once_per_session"] = "once_per_session"


@dataclass(frozen=True)
class EachCallPolicy:
    type: Literal["each_call"] = "each_call"


@dataclass(frozen=True)
class EveryMinutesPolicy:
    minutes: int = 0
    type: Literal["every_minutes"] = "every_minutes"


Policy = Union[OncePerSessionPolicy, EachCallPolicy, EveryMinutesPolicy]


def normalise_policy(p: Union[Policy, PolicyShorthand, dict]) -> Policy:
    """Coerce a string shorthand or dict-form policy into the dataclass form."""
    if isinstance(p, str):
        if p == "once_per_session":
            return OncePerSessionPolicy()
        if p == "each_call":
            return EachCallPolicy()
        raise ValueError(f"Unknown policy shorthand: {p!r}")
    if isinstance(p, dict):
        t = p.get("type") or p.get("policy")
        if t == "once_per_session":
            return OncePerSessionPolicy()
        if t == "each_call":
            return EachCallPolicy()
        if t == "every_minutes":
            return EveryMinutesPolicy(minutes=int(p["minutes"]))
        raise ValueError(f"Unknown policy dict: {p!r}")
    return p


@dataclass
class FdkeyConfig:
    """Per-server config passed to with_fdkey()."""

    api_key: str
    protect: dict[str, dict[str, Any]] = field(default_factory=dict)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    on_fail: Literal["block", "allow"] = "block"
    on_vps_error: Literal["block", "allow"] = "allow"
    inline_challenge: bool = False
    vps_url: Optional[str] = None
    discovery_url: Optional[str] = None
    tags: Optional[dict[str, str]] = None


@dataclass
class FdkeyContext:
    """Read-only context surfaced to integrator tool handlers via
    get_fdkey_context(). `score` and `tier` are first-class fields —
    today they are effectively binary (1.0 = passed, 0.0 = failed),
    but the wire shape reserves the float for forward-compat capability
    scoring without an API change."""

    verified: bool
    verified_at: Optional[int]
    score: Optional[float]
    tier: Optional[str]
    claims: Optional[dict[str, Any]]


@dataclass
class SessionState:
    """Per-connection mutable state. Mirrors the TypeScript SDK's
    SessionState. Keyed by MCP session id (or 'stdio' for stdio transport)."""

    verified: bool = False
    verified_at: Optional[int] = None
    last_touched_at: int = 0
    """Timestamp (ms epoch) of the last access. Drives LRU + TTL eviction
    in `SessionStore` so the SDK doesn't leak session entries on
    long-lived shared servers. Touched on every `store.get(...)` call."""
    fresh_verification_available: bool = False
    pending_challenge_id: Optional[str] = None
    last_claims: Optional[dict[str, Any]] = None
    client_info: Optional[dict[str, Any]] = None
    protocol_version: Optional[str] = None
    mcp_session_id: Optional[str] = None
    transport: Literal["stdio", "http", "unknown"] = "unknown"
