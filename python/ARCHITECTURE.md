# `fdkey` (Python SDK) — Architecture Reference

> **Purpose.** Python port of the TypeScript SDK at `@fdkey/mcp`. Same wire format, same JWT, same per-session policy semantics. Wraps `mcp.server.fastmcp.FastMCP` to inject the two FDKEY tools and gate `protect`-listed tool calls behind a verification challenge.
>
> **Last verified against:** `src/fdkey/` as of 2026-05-11 (0.2.0).
>
> **What's new since 0.1.x:**
> - **0.2.0** — Parity with `@fdkey/mcp` 0.3.1 (TypeScript). SDK is now
>   puzzle-agnostic; all agent-facing prose lives on the VPS. Two parallel
>   changes:
>   - `mcp_response_text` passthrough on the challenge response: when the
>     VPS supplies the field (sent for `client_type='mcp'`),
>     `fdkey_get_challenge` returns it verbatim as the tool result. The
>     `inline_challenge` path uses the same renderer. Falls back to a
>     JSON dict (header + puzzles + example_submission + footer) when the
>     VPS doesn't supply the field.
>   - Stable MCP tool annotations: both injected tools register with
>     `ToolAnnotations(title, readOnlyHint=False, destructiveHint=False,
>     idempotentHint=False, openWorldHint=True)`. Passed via FastMCP's
>     `add_tool(..., annotations=...)` keyword (with transparent fallback
>     for older `mcp` versions lacking the keyword).
>
> Prior baseline (0.1.x): initial release; one shared `httpx.AsyncClient`
> per VPSClient/WellKnownClient for connection-pool reuse.
>
> **Companion docs.**
> - [../typescript/ARCHITECTURE.md](../typescript/ARCHITECTURE.md) — `@fdkey/mcp`, the language-of-record SDK whose wire shape this port mirrors.
> - [../../../vps/ARCHITECTURE.md](../../../vps/ARCHITECTURE.md) — VPS scoring server. The Python SDK speaks the exact same `/v1/challenge` and `/v1/submit` endpoints as the TS SDK.

---

## § 1 — Top-level

`fdkey` (PyPI) is the Python integrator surface for FDKEY. It mirrors the TypeScript SDK's behavior:

- Injects `fdkey_get_challenge` + `fdkey_submit_challenge` MCP tools.
- Wraps `FastMCP.add_tool` / `FastMCP.tool` so any tool listed in `protect` returns `fdkey_verification_required` until the connecting agent has solved a challenge.
- Talks to `https://api.fdkey.com` over HTTPS via `httpx.AsyncClient`.
- Verifies Ed25519 JWTs offline using `PyJWT[crypto]` against a 1-hour cache of public keys from `/.well-known/fdkey.json`.

**Per-HTTP-session isolation (the multi-tenant case).** Each HTTP-Streamable client connection has its own `mcp.server.lowlevel.server.ServerSession` instance. The mcp package threads it through a `request_ctx` `ContextVar` for the duration of every tool-call dispatch. `_resolve_session_id()` reads that contextvar and looks the session up in `_SessionKeyTracker` — a module-level `WeakKeyDictionary[ServerSession, str]` that maps each live session to a fresh UUID assigned on first sight. The UUID is `f"mcp-{uuid4().hex}"`. Two HTTP clients hitting one shared `FastMCP` server get isolated `SessionState` entries (verified by `tests/test_session_correlation.py::test_two_clients_have_isolated_verification_state`).

**Why not just `id(session)`?** Python's `id()` is the memory address. After a `ServerSession` is garbage-collected, that address is free for reuse by the allocator. A long-lived `SessionStore` entry (TTL is 1h) keyed on the old address could be resurrected for a new, unrelated session — a cross-tenant verification leak. The UUID is monotonically unique per process, and `weakref.finalize(session, ...)` evicts the corresponding `SessionStore` entry the moment the session is gc'd, so the id-reuse window closes immediately rather than waiting for the TTL. Verified by `tests/test_session_correlation.py::test_session_state_evicted_when_session_is_gc_collected`.

**Stdio transport** falls through to the literal `"stdio"` key (one session for life of the process — correct).

**What this SDK does NOT do** that the TypeScript one does:
- **MCP `initialize` handshake metadata capture.** FastMCP's hook surface for the low-level Server's `initialize` request and `oninitialized` callback differs by mcp package version. Capturing `clientInfo`, `protocol_version`, etc. is intentionally deferred — the wire schema accepts a missing `agent` block. Add when the FastMCP API stabilizes.

### Layer model

```
with_fdkey(server, api_key=..., protect={...})
  │
  ├─ Build _FdkeyState bundle (httpx clients, JWT verifier, session map)
  │   and attach it to the server via setattr(server, "_fdkey_state", state)
  ├─ Register fdkey_get_challenge and fdkey_submit_challenge via
  │   server.add_tool(...) (or server.tool() if add_tool unavailable)
  ├─ Monkey-patch server.add_tool / server.tool to intercept future
  │   registrations matching `protect`
  └─ Return the same server instance (mutated)

Per-call (gated tool):
  handler invocation
  ├─ Read sid from the _active_session_id ContextVar (default: 'stdio')
  ├─ Look up SessionState in state.sessions
  ├─ guard.can_call(policy, name, session)? → run original or return
  │      "fdkey_verification_required" string
  └─ On success: guard.consume_policy(policy, session)
```

---

## § 2 — Directory map

```
mcp-integration/sdks/python/
├─ src/fdkey/
│  ├─ __init__.py        — Public re-exports: with_fdkey, get_fdkey_context,
│  │                        FdkeyConfig, FdkeyContext, Policy. __version__.
│  ├─ middleware.py      — with_fdkey() entry point. Wraps FastMCP, registers
│  │                        the two FDKEY tools, monkey-patches add_tool/tool.
│  │                        SDK_VERSION constant lives here.
│  ├─ guard.py           — Pure-function policy logic. can_call, mark_verified,
│  │                        consume_policy. Mirrors the TS guard byte-for-byte.
│  ├─ session_store.py   — Bounded `SessionStore` keyed by MCP session id.
│  │                        TTL eviction (1h idle) + LRU hard cap (10k).
│  │                        Sweep-on-access; no background tasks. Mirrors
│  │                        the TS SDK's session-store.ts byte-for-byte.
│  ├─ types.py           — Public types: FdkeyConfig, FdkeyContext (with
│  │                        first-class score/tier), Policy union, SessionState.
│  ├─ vps_client.py      — VpsClient + ChallengeResponse + SubmitResponse.
│  │                        ONE shared httpx.AsyncClient per instance — keeps
│  │                        the keepalive pool warm across requests.
│  ├─ jwt_verify.py      — JwtVerifier + extract_score + extract_tier.
│  │                        Uses PyJWT[crypto] for Ed25519 with 30s leeway.
│  └─ well_known.py      — WellKnownClient. {kid → public_key} cache, 1h TTL,
│                            refreshes on unknown kid (mid-rotation handling).
│                            Shared httpx client.
├─ tests/
│  ├─ test_guard.py      — Pure-function tests. Mirrors guard.test in TS.
│  └─ test_jwt_verify.py — Verify a known-good JWT, reject unknown kid.
│                            Uses respx to mock httpx.
├─ pyproject.toml        — name=fdkey, version=0.2.0. Build: hatchling.
│                            Deps: mcp, httpx, pyjwt[crypto], cryptography.
│                            Dev deps: pytest, pytest-asyncio, respx.
├─ LICENSE               — MIT.
├─ README.md             — Install + with_fdkey example + policy reference.
└─ ARCHITECTURE.md       — This file.
```

---

## § 3 — Per-file detail

### `src/fdkey/middleware.py`

**Public exports.**
- `with_fdkey(server, *, api_key, protect=None, difficulty="medium", on_fail="block", on_vps_error="allow", inline_challenge=False, vps_url=None, tags=None)` — the wrapper.
- `get_fdkey_context(server, extra_or_session_id) -> Optional[FdkeyContext]` — read verified state, capability `score`, `tier`, decoded JWT claims for the current session.

**Internals.**
- `_FDKEY_ATTR = "_fdkey_state"` — sentinel attribute on the FastMCP server holding the per-server `_FdkeyState` bundle.
- `_active_session_id: ContextVar[Optional[str]]` — the seam for HTTP-Streamable session correlation when FastMCP's API exposes it. Today: `None` → falls through to `'stdio'` for everyone.
- `_register_fdkey_tools(server, state)` — best-effort registration: tries `server.add_tool` first, falls back to `server.tool` decorator. Errors loudly if neither exists. Passes `annotations=ToolAnnotations(...)` for trust-hint compatibility with newer MCP clients; transparently falls back to no-annotations registration on older `mcp` package versions that lack the keyword (caught via `TypeError`). Annotation values (`_GET_CHALLENGE_ANNOTATIONS`, `_SUBMIT_CHALLENGE_ANNOTATIONS`) are stable across puzzle types / timing config.
- `_wrap_tool_registrar(server, state)` — monkey-patches BOTH `add_tool` and `tool` on the server. Future tools registered with names in `state.protect` get wrapped via `_wrap_handler`.
- `_wrap_handler(fn, tool_name, policy, state)` — async wrapper that consults `guard.can_call` before delegating. On guard miss, returns the literal `"fdkey_verification_required..."` string (FastMCP auto-wraps strings into TextContent).

**SDK_VERSION** is hand-maintained at `'0.2.0'` and forwarded to the VPS as `integrator.sdk_version`. Keep in sync with `pyproject.toml [project] version` and `__init__.py __version__`.

**Challenge passthrough.** `_make_get_challenge_handler` returns
`_challenge_text(challenge)`, which prefers `challenge.mcp_response_text`
verbatim (the VPS-rendered directive) and falls back to a JSON-stringified
`_challenge_payload(challenge)` dict otherwise. The fallback dict is
puzzle-agnostic — it passes `puzzles` and `example_submission` through
unmodified. The `inline_challenge` blocked-tool error uses the same
renderer for consistency. No SDK-side puzzle rendering, no per-type
branches — adding a puzzle type on the VPS doesn't touch this file.

---

### `src/fdkey/guard.py`

Pure functions over `SessionState`. No I/O. Mirrors `guard.ts` and `guard.rs` byte-for-byte (same state machine: `verified`, `fresh_verification_available`, `verified_at` epoch ms).

`now_ms()` reads `time.time()` once per call.

---

### `src/fdkey/types.py`

Dataclasses for type-safe surface.

- `FdkeyContext` — surfaced via `get_fdkey_context()`. **`score: Optional[float]` and `tier: Optional[str]` are first-class fields** (extracted from `claims` for ergonomics; the wire reserves the float for graduated capability scoring).
- `FdkeyConfig` — full config dataclass (mirrors TS `FdkeyConfig`).
- `Policy` — `Union[OncePerSessionPolicy, EachCallPolicy, EveryMinutesPolicy]` plus `normalise_policy(...)` which accepts string shorthand or dict-form input.
- `SessionState` — per-session mutable bag; same shape as the TS `SessionState`.

---

### `src/fdkey/vps_client.py`

**Critical:** `VpsClient.__init__` constructs ONE `httpx.AsyncClient(timeout=10s)` and reuses it across `_post()` calls. Constructing one per call (which the initial implementation did) defeats httpx's connection pooling and forces a new TCP+TLS handshake every challenge. `aclose()` is exposed for explicit shutdown but Python's GC handles the common case.

`fetch_challenge(meta)` posts to `/v1/challenge`. Body matches the TS SDK exactly:
```json
{
  "difficulty": "...", "client_type": "mcp",
  "agent": { ... },         // only included if at least one field populated
  "integrator": { ... },
  "tags": { ... }
}
```

`submit_answers(challenge_id, answers)` posts to `/v1/submit`.

`VpsHttpError` raised on non-2xx; carries `status` + parsed body so the middleware can branch on `error == "challenge_expired"` etc.

---

### `src/fdkey/jwt_verify.py`

`JwtVerifier.verify(token)` flow:
1. `pyjwt.get_unverified_header(token)` → `kid`.
2. `WellKnownClient.get_key(kid)` → `cryptography` public-key object.
3. `pyjwt.decode(..., algorithms=["EdDSA"], leeway=30, options={"verify_aud": False})`.
4. Returns the claims dict, or `None` on any failure.

**Why `verify_aud=False`:** the SDK doesn't know its own `vps_users.id` at verify time. The VPS already binds aud to the api_key that requested the challenge — defense in depth. Same choice as the TS and Rust ports. Caveat: a JWT issued for one integrator's id could in principle be replayed against another FDKEY-protected service within the JWT lifetime (~5 min default).

`extract_score(claims)` and `extract_tier(claims)` — defensive accessors with explicit type checks (handle missing field, wrong type). Used by `get_fdkey_context()` to populate the first-class fields.

---

### `src/fdkey/well_known.py`

Shared `httpx.AsyncClient(timeout=5s)`. Cache: `dict[str, object]` (kid → cryptography public-key). TTL: 1 hour. On unknown kid (mid-rotation), refreshes once before returning `None`. Thread-safety: not currently locked — concurrent first-use calls may both trigger a refresh, but the second simply overwrites with identical data. Acceptable for a single-process MCP server.

---

## § 4 — Configuration reference

| Field | Default | Purpose |
|---|---|---|
| `api_key` (required) | — | Bearer token. Must match a `vps_users.key_sha256` row on the target VPS. |
| `protect` | `{}` | `{tool_name: {"policy": "each_call" \| "once_per_session" \| {"type": "every_minutes", "minutes": N}}}` |
| `difficulty` | `"medium"` | `"easy" \| "medium" \| "hard"` — forwarded to the VPS. |
| `on_fail` | `"block"` | `"block" \| "allow"` — what to do when the agent fails the puzzle. |
| `on_vps_error` | `"allow"` | `"block" \| "allow"` — what to do when the VPS is unreachable. Default `"allow"` (fail-open) so an FDKEY outage doesn't brick integrator workflows. |
| `inline_challenge` | `False` | Embed puzzle JSON in the blocked-tool error so the agent can submit without a separate `fdkey_get_challenge` round-trip. |
| `vps_url` | `https://api.fdkey.com` | Override for self-hosted FDKEY. |
| `tags` | `None` | Free-form non-PII labels forwarded to FDKEY for analytics. |

---

## § 5 — Cross-cutting concerns

### Threading model

The SDK is **safe under multi-threaded access**, even though the conventional `mcp` Python deployment is asyncio-only. Two integrator-side patterns motivate this:

1. Integrators wrapping the SDK in a thread-pool web framework (Flask, Quart with `run_sync`).
2. `asyncio.to_thread()` used adjacent to FDKEY context (e.g. blocking auth checks).

In both cases, two threads can race through the same `SessionStore.get(sid)` or `_SessionKeyTracker.key_for(session)` and — without locks — produce two `SessionState` instances for one connection, with one of them silently discarded by the dict overwrite.

Mechanism:
- `SessionStore` holds a `threading.RLock` around all mutators (`get`, `peek`, `delete`, `size`). Reentrant because the gc-finalizer on a `ServerSession` may call `delete()` synchronously mid-`get()` under aggressive gc tuning.
- `_SessionKeyTracker.key_for` holds a `threading.Lock` over the entire get-or-create critical section, including the `WeakKeyDictionary` insert and `weakref.finalize` registration.

Lock contention is essentially nil in single-threaded asyncio (~100 ns per acquire), so the cost is invisible against any real workload. Verified by `tests/test_thread_safety.py`.

### Test coverage

- `test_guard.py` — five tests covering all three policy variants + freshness consumption + uninitialized-session behavior.
- `test_jwt_verify.py` — four tests: JWT round-trip via respx-mocked well-known + `extract_score`/`extract_tier` defensive checks.
- `test_session_store.py` — five tests: TTL eviction, LRU cap, peek-doesn't-touch-LRU, `delete()` correctness, size tracking.
- `test_session_correlation.py` — five tests: stable per-session keys, gc-eviction safety (the id-reuse window closure), two-client isolation end-to-end.
- `test_session_correlation` autouse fixture isolates the `request_ctx` ContextVar between tests.
- `test_thread_safety.py` — three thread-stress tests: 32 threads × 500 calls on shared sid (single SessionState identity preserved), 1000 distinct sids (all entries survive), and concurrent get/peek/delete (no exceptions, no dict-mid-iteration crashes).
- `test_middleware.py` — six tests covering tool wrapping, gating, EachCall ticket consumption, OncePerSession persistence, unprotected tools passing through.
- `test_version_sync.py` — version constants kept in sync across `pyproject.toml`, `__init__.py`, and `middleware.py`.

### Wire-format synchronization

This is the rule: every byte FDKEY's VPS sees from this SDK matches what the TS SDK sends. If a TS SDK release changes the challenge body, this SDK gets the same change in the same release — coordinated via [`../typescript/ARCHITECTURE.md` § 6](../typescript/ARCHITECTURE.md#-6--public-api-surface).

### MCP SDK version compatibility

The `mcp` package's API is still evolving. `_register_fdkey_tools` defensively probes for both `server.add_tool(...)` and `server.tool(...)` — works against either path FastMCP might expose. `_read_server_info` falls through several private/public attribute names. If a future `mcp` release adds a stable hook for `clientInfo` capture, that's where to add the metadata-forwarding code path.

---

## § 6 — Maintenance protocol

> **Rule:** when you change `src/fdkey/**` or `pyproject.toml`'s public surface, update this file.

Common changes:
- New field on `FdkeyContext`? → `types.py` + matching field in TS `FdkeyContext` and Rust `FdkeyContext`. README "Reading verification context" section.
- New policy variant? → `types.py` + `guard.py` (exhaustive isinstance match). Same change in TS + Rust.
- Bumped version? → `pyproject.toml [project] version`, `src/fdkey/__init__.py __version__`, AND `src/fdkey/middleware.py SDK_VERSION` (all three must match).
- `mcp` package introduces `set_request_handler` / `oninitialized` parity with TS? → wire it in `with_fdkey` to capture `clientInfo` + `protocol_version`. Update `_meta_for` to populate the `agent` block.
