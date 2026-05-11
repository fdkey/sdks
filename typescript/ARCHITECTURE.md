# `@fdkey/mcp` (TypeScript SDK) — Architecture Reference

> **Purpose of this doc.** Single source of truth for the TS SDK's source structure, file responsibilities, public API surface, MCP integration points, and the wire-format contract with the VPS. Consult this before re-reading source files. Update this whenever you change `src/**` or `package.json`'s public surface.
>
> **Companion docs.**
> - [../../PLAN.md](../../PLAN.md) — Pillar 3 architecture decision: SDK + JWT, not in-process middleware.
> - [../../../vps/ARCHITECTURE.md](../../../vps/ARCHITECTURE.md) — VPS scoring server's wire-format counterpart.
> - [`../../../FDKEY_IMPLEMENTATION_MASTER.md`](../../../FDKEY_IMPLEMENTATION_MASTER.md) — top-level vision and locked decisions.
>
> **Last verified against:** `src/` as of 2026-05-11 (0.3.1).
>
> **What's new since 0.2.0** (the previous reference baseline):
> - **0.2.9** — `FdkeyConfig.sessionStore` is now pluggable. Integrators on
>   Cloudflare Workers / Durable Objects MUST pass a persistent backing
>   (e.g. `ctx.storage.sql`-backed) — the default in-memory `Map` doesn't
>   survive DO hibernation. The SDK exposes `SessionStore`, `SessionState`,
>   and `newSession()` for integrators to wire one up.
> - **0.3.0** — SDK is now **puzzle-agnostic**. The `fdkey_submit_challenge`
>   inputSchema is opaque (`Record<string, unknown>`); per-type Zod sub-
>   schemas removed. The VPS now renders a full directive into a
>   `mcp_response_text` field on the challenge response, and the SDK
>   returns it verbatim as the tool result — no SDK-side puzzle rendering,
>   no specific time numbers in any agent-facing string.
> - **0.3.1** — Both injected tools carry stable MCP `annotations`
>   (`title`, `readOnlyHint: false`, `destructiveHint: false`,
>   `idempotentHint: false`, `openWorldHint: true`). Values are
>   puzzle-agnostic and timing-agnostic — adding a puzzle type or
>   tweaking TTL on the VPS does NOT change them.
>
> Prior baseline (post 0.2.0): Workers/Bun/Deno compat via lazy-loaded
> multi-VPS router; default routing path uses global `fetch`, undici moved
> to `optionalDependencies`; `FdkeyContext.score` and `.tier` promoted to
> first-class fields; agent info + MCP-Session-Id capture; IP-pinned
> routing via `VpsEndpoint.ip` + per-call dispatcher + SNI=`api.fdkey.com`.

---

## § 1 — Top-level

`@fdkey/mcp` is **FDKEY Pillar 3 client surface** — the npm package an integrator imports to gate their own MCP server tools behind FDKEY verification. It is delivered as **a thin SDK, not in-process middleware** — see [PLAN.md § "always was"](../../PLAN.md) for the architecture-evolution rationale.

What the SDK does:
- Injects two MCP tools (`fdkey_get_challenge`, `fdkey_submit_challenge`) into the integrator's MCP server via `server.registerTool(...)`.
- Wraps the server's `registerTool` / `tool` registration so any tool the integrator chooses to gate (`protect: { name: { policy: ... } }`) returns `fdkey_verification_required` until the agent has solved a challenge on this connection.
- Talks HTTP to `api.fdkey.com` (or a self-hosted VPS) for `/v1/challenge` and `/v1/submit`.
- Verifies the Ed25519 JWT returned on a successful submit **offline**, using the public key fetched once from `/.well-known/fdkey.json`.
- Captures structured agent metadata from the MCP `initialize` handshake and forwards it on every challenge fetch (clientInfo, capabilities, protocol version, transport, MCP session id, plus integrator-supplied `tags`).

### Runtimes

The SDK runs on any runtime with a global `fetch`, AbortSignal, and Web Crypto. Tested matrix:

| Runtime              | Default (StaticRouter) | `discoveryUrl` (VpsRouter) |
| -------------------- | :--------------------: | :------------------------: |
| Node 18+             | ✅                      | ✅                          |
| Cloudflare Workers   | ✅                      | ❌ (undici, Node-only)      |
| Bun                  | ✅                      | ✅                          |
| Deno                 | ✅                      | ⚠️ untested                 |

The split is mechanical:
- `StaticRouter` (in `src/router-static.ts`) is pure: pure types, native `fetch`, no `undici`.
- `VpsRouter` (in `src/vps-router.ts`) imports `undici`'s `Agent` to do IP-pinning via a custom DNS lookup. That binding is **only** loaded when the integrator passes `discoveryUrl`. `index.ts` reaches `VpsRouter` through `LazyVpsRouter`, which calls `await import('./vps-router.js')` on its first `getTarget()`. Bundlers (esbuild, wrangler, rollup) treat dynamic imports as side-effect-free at the entry point, so Workers builds do not pull undici when the integrator stays on the default path.
- `vps-client.ts` and `well-known.ts` use the global `fetch` and only attach the `dispatcher` field on the `RoutingTarget` if the router populated it — so on `StaticRouter`, fetch is invoked with a clean `RequestInit`.

`undici` is declared as an `optionalDependency` so `npm install @fdkey/mcp` succeeds on Workers tooling that refuses to install Node-only packages.

What the SDK does **NOT** do:
- It does not proxy or wrap the integrator's MCP traffic — agent ↔ integrator MCP messages flow directly between the integrator's server and the agent.
- It does not see prompts, tool inputs, tool outputs, or any user data.
- It does not perform any cryptographic operation against integrator-owned data — only verifies our own JWTs.

### How a single tool call flows

```
Agent ──tools/call my_protected_tool──► Integrator's MCP server
                                                │
                                                │  intercepted by withFdkey() Proxy
                                                │  if !canCall(policy, session):
                                                │     return mkError("fdkey_verification_required")
                                                ▼
                                     [Agent must call fdkey_get_challenge first]
                                                │
                                                ▼
        fdkey_get_challenge ───── HTTPS POST /v1/challenge ─────► api.fdkey.com
                                  body: { difficulty, client_type,
                                          agent, integrator, tags }
                                                │
                                                ▼
                                     puzzle JSON returned to agent
                                                │
        fdkey_submit_challenge ─── HTTPS POST /v1/submit ──────► api.fdkey.com
                                  body: { challenge_id, answers }
                                                │
                                                ▼
                                     { verified, jwt? }
                                                │
                                  jose.jwtVerify(jwt, pubkey from /.well-known/)
                                                │
                                  on success: markVerified(session)
                                                │
        Agent ──tools/call my_protected_tool──► canCall(...) now true
                                                │
                                                ▼
                                  Integrator's original handler runs
```

### Layer model

```
withFdkey(server, config)
  │
  ├─ injects two tools via server.registerTool(...)
  ├─ wraps server.registerTool / server.tool with a Proxy
  │   so future tool() calls get gated against `protect` config
  ├─ hooks server.server.setRequestHandler(InitializeRequestSchema)  ──► protocol version capture
  ├─ hooks server.server.oninitialized                               ──► clientInfo + capabilities capture
  └─ returns the proxied server (integrator uses it like normal)

Per-call:
  tool handler invoked
  ├─ session lookup (Map<sessionId, SessionState>)
  ├─ canCall(policy, session)?  → run original or block
  ├─ on guard miss: optionally fetch challenge inline (inlineChallenge config)
  └─ on success: consumePolicy(...) (resets each_call ticket)

VPS interactions are routed through:
  VpsClient → VpsRouter (StaticRouter for vpsUrl, VpsRouter for CDN discovery + failover)
  WellKnownClient → cached public key map for offline JWT verify
```

---

## § 2 — Directory map

```
mcp-integration/sdks/typescript/
├─ src/
│  ├─ index.ts          — Entry point. withFdkey(), getFdkeyContext(), the two
│  │                      injected MCP tools, the registerTool/tool Proxy, the
│  │                      MCP-handshake hooks (initialize + oninitialized).
│  │                      Hardcoded SDK_VERSION constant.
│  ├─ guard.ts          — Per-session verification policy logic. newSession,
│  │                      canCall, markVerified, consumePolicy. Pure functions
│  │                      over SessionState — no I/O, easy to unit test.
│  ├─ types.ts          — Public types: FdkeyConfig (incl. `tags`), Policy,
│  │                      ProtectEntry, AgentMeta, IntegratorMeta, ChallengeMeta,
│  │                      SessionState, VpsEndpoint, WellKnownPayload,
│  │                      WellKnownKey. Plus normalisePolicy() helper.
│  ├─ vps-client.ts     — HTTP client for api.fdkey.com. fetchChallenge(meta?),
│  │                      submitAnswers(challengeId, answers). VpsHttpError class.
│  │                      Marks endpoints failed on 5xx / network errors so the
│  │                      router can fail over.
│  ├─ router-static.ts  — Pure StaticRouter implementation (no undici).
│  │                      Used on the default single-VPS path. Works on
│  │                      every runtime with a global fetch.
│  ├─ vps-router.ts     — Multi-VPS routing with undici-backed IP-pinning.
│  │                      Lazy-loaded by index.ts only when `discoveryUrl` is
│  │                      set. Cloudflare CDN discovery + latency probing +
│  │                      7-day endpoint cache. Node-only.
│  ├─ session-store.ts  — Bounded `SessionStore` keyed by MCP session id.
│  │                      TTL eviction (1h idle) + LRU hard cap (10k).
│  │                      Sweep-on-access; no background timers.
│  ├─ index.test.ts     — Vitest. Asserts vps-router.js stays out of the
│  │                      StaticRouter default path; asserts FdkeyContext
│  │                      surfaces score and tier as first-class fields;
│  │                      asserts SessionStore enforces TTL + LRU cap and
│  │                      that `peek()` doesn't slide LRU position.
│  └─ well-known.ts     — /.well-known/fdkey.json fetcher. Caches a Map<kid,
│                          KeyLike> for 1h, refreshes on missing kid (handles
│                          mid-rotation gracefully).
├─ dist/                — tsc output. ESM .js + .d.ts. The only thing shipped
│                          to npm via `files: ["dist"]` in package.json.
├─ node_modules/        — gitignored.
├─ package.json         — name, version, exports, deps. peerDependency:
│                          @modelcontextprotocol/sdk. Runtime deps:
│                          jose (Ed25519 JWT verify), zod (input schemas).
├─ tsconfig.json        — Strict TS, ESM target.
└─ ARCHITECTURE.md      — This file.
```

---

## § 3 — Per-file detail

### `src/index.ts`

**Purpose.** Top-level entrypoint. Defines `withFdkey()`, the two MCP tools (`fdkey_get_challenge`, `fdkey_submit_challenge`), the `registerTool`/`tool` interception Proxy, the MCP-handshake hooks that capture agent metadata, and `getFdkeyContext()` for integrator handlers.

**Public exports.**
- `withFdkey(server: McpServer, config: FdkeyConfig): McpServer` — main wrapper.
- `getFdkeyContext(server, extraOrSessionId): FdkeyContext | null` — read the verified state, capability score, tier, and decoded JWT claims for the current session from inside an integrator's tool handler. `FdkeyContext` exposes `score: number | null` and `tier: string | null` as first-class fields (extracted from `claims` for ergonomics; the wire field is reserved for graduated capability scoring later, today effectively binary 1.0/0.0).
- Re-exports: `FdkeyConfig`, `Policy`, `AgentMeta`, `IntegratorMeta`, `ChallengeMeta` (types).

**Internal constants.**
- `SDK_VERSION = '0.3.1'` — hardcoded; **must stay in sync with `package.json` version** (an `index.test.ts` smoke test asserts equality). Forwarded to the VPS as `integrator.sdk_version` for cross-version debugging.
- `GET_CHALLENGE_TOOL = 'fdkey_get_challenge'`, `SUBMIT_CHALLENGE_TOOL = 'fdkey_submit_challenge'` — tool names exposed to agents.
- `GET_CHALLENGE_DESC` / `SUBMIT_CHALLENGE_DESC` — tool descriptions agents read.

**Imports (internal).** `./types.js`, `./guard.js`, `./vps-client.js`, `./router-static.js`, `./well-known.js`. **`./vps-router.js` is reached only via dynamic `await import()` inside `LazyVpsRouter`** so Workers/Bun/Deno bundles never pull undici on the default StaticRouter path.

**Imports (external).** `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`), `@modelcontextprotocol/sdk/types.js` (`InitializeRequestSchema`), `jose` (`jwtVerify`, `decodeProtectedHeader`, `decodeJwt`), `zod`.

**Imported by.** Integrators directly via `import { withFdkey } from '@fdkey/mcp'`. Demo server at `mcp-integration/demo-server/src/server.ts` is the in-repo consumer.

**Side effects.** Calls `server.registerTool(...)` twice (the injected tools) and replaces `server.registerTool` and `server.tool` via a `Proxy` so future registrations are intercepted. Reaches into `server.server` (the underlying low-level MCP `Server` instance) to:
- Set `server.server.oninitialized` — chains the previous handler if any.
- Call `server.server.setRequestHandler(InitializeRequestSchema, …)` — wraps the existing handler retrieved from `server.server._requestHandlers` (private API access — see Gotchas).
- Read `server.server._serverInfo` for `integrator.server_name` / `server_version` (also private API).

**Agent metadata capture flow (Step 2A + 2A.5).**
1. **`InitializeRequestSchema` handler hook** — runs synchronously during the initialize request. Reads `request.params.protocolVersion` from the agent's payload and stashes in closure-scope `latestProtocolVersion`. Then delegates to the original handler retrieved from the underlying `Server`'s private `_requestHandlers` map. Failure to read protocolVersion is swallowed in a try/catch — never breaks initialize.
2. **`oninitialized` callback** — runs after `notifications/initialized` arrives from the agent. At that point, `server.server.getClientVersion()` and `getClientCapabilities()` are populated. Captures clientInfo (name, version, optional title) + capabilities into closure-scope `latestClientInfo`. Chains the previous `oninitialized` if any.
3. **`captureChallengeMeta(session, extra)`** — called per tool call. Uses `??=` guards to copy closure-scope info into `session.clientInfo` / `session.protocolVersion` / `session.mcpSessionId` / `session.transport` (idempotent — re-runs are no-ops). Returns a `ChallengeMeta` bundle ready to pass to `vpsClient.fetchChallenge(meta)`.

**Tool registration interception.** A `Proxy` over the `McpServer` intercepts `get` for `registerTool` and `tool`. Returns a wrapper that:
- Passes through unchanged for the two FDKEY tools (already registered by us).
- For tools listed in `config.protect`, wraps the original handler with a guard that calls `canCall(policy, session)` first. If false, returns `mkError("fdkey_verification_required …")`. If `inlineChallenge: true`, also fetches a challenge and embeds the puzzle JSON in the error message so the agent can submit without a separate `fdkey_get_challenge` call.
- For un-protected tools, passes through unchanged.

**Gotchas / private API access.**
- `server.server.setRequestHandler(InitializeRequestSchema, …)` overrides the built-in handler the underlying `Server` registered in its constructor. We retrieve the original via `server.server._requestHandlers.get('initialize')` and re-invoke it after capture. **This relies on the MCP TS SDK keeping `_requestHandlers` as a `Map` keyed by method name.** If the SDK refactors that internal, we lose the protocol_version capture (the rest of the SDK keeps working — protocolVersion is optional). Type assertions are bounded to the few lines that need them and gracefully degrade via `?.` chains.
- `server.server._serverInfo` is also private. Same pattern: graceful `?.` access. If unavailable, `integrator.server_name` / `server_version` are simply undefined — those fields are optional in the wire schema.
- The Proxy intercepts both `registerTool` (current MCP SDK API) and `tool` (deprecated). Don't drop the deprecated one until MCP TS SDK actually removes it.

---

### `src/guard.ts`

**Purpose.** Pure-function policy evaluation. No I/O, no state outside the `SessionState` argument. Trivial to unit-test.

**Public exports.**
- `newSession(): SessionState` — fresh session with all metadata fields nulled.
- `canCall(policy: Policy, toolName: string, session: SessionState): boolean` — true iff the session's verification state satisfies the policy.
- `markVerified(session: SessionState): void` — called from the submit tool handler on a successful verify.
- `consumePolicy(policy: Policy, session: SessionState): void` — called after a protected tool runs successfully to consume the `each_call` ticket.

**Imports (internal).** `./types.js` (types only).

**Imports (external).** None.

**Imported by.** `index.ts`.

**Policy semantics.**
- `once_per_session` — pass forever once `verified=true`.
- `each_call` — pass only when `freshVerificationAvailable=true`; consumed on each gated-tool call. Verification has to be redone for every protected call. Most paranoid.
- `every_minutes: N` — pass while `now - verifiedAt < N*60_000`. The clock does NOT extend on calls; it expires N minutes after the puzzle was solved.

---

### `src/types.ts`

**Purpose.** Public type surface plus internal types shared across the SDK.

**Public exports (types).**
- `Policy` — discriminated union over `'once_per_session' | 'each_call' | { type: 'every_minutes'; minutes }`.
- `PolicyShorthand` — string form for ergonomic config.
- `ProtectEntry` — `{ policy: Policy | PolicyShorthand }`.
- `FdkeyConfig` — full config for `withFdkey(...)`. See § 4.
- `AgentMeta` — agent block forwarded on /v1/challenge.
- `IntegratorMeta` — integrator block forwarded on /v1/challenge.
- `ChallengeMeta` — `{ agent?, integrator?, tags? }` bundle, single argument to `VpsClient.fetchChallenge`.
- `SessionState` — per-session map value.
- `VpsEndpoint`, `WellKnownKey`, `WellKnownPayload` — VPS-side schemas the SDK consumes.

**Public exports (functions).**
- `normalisePolicy(p: Policy | PolicyShorthand): Policy` — coerces shorthand strings to the discriminated form.

**Imports.** None.

**Imported by.** Every other source file in the SDK.

---

### `src/vps-client.ts`

**Purpose.** HTTP client for `api.fdkey.com` (or a self-hosted alternative). Wraps `fetch` with a 10s timeout, JSON encoding, error mapping, and endpoint-failure reporting back to the router for failover.

**Public exports.**
- `class VpsClient` — `fetchChallenge(meta?: ChallengeMeta): Promise<ChallengeResponse>`, `submitAnswers(challengeId, answers): Promise<SubmitResponse>`.
- `class VpsHttpError` — thrown for non-2xx responses; carries `status` and the parsed body (`{ error?, message?, ... }`).
- `interface ChallengeResponse` — `{ challenge_id, expires_at, expires_in_seconds?, difficulty, types_served, header?, puzzles, footer? }`.
- `interface SubmitResponse` — `{ verified, jwt?, types_passed?, types_served?, required_to_pass?, breakdown? }`.

**Imports (internal).** `./types.js` (`ChallengeMeta`), `./vps-router.js` (`IVpsRouter`).

**Imports (external).** None directly — uses global `fetch` and `AbortSignal.timeout`.

**Imported by.** `index.ts`.

**Side effects.** HTTP requests. Calls `router.recordFailure(url)` on network errors and 5xx responses (so VpsRouter can fail over). 4xx responses are treated as client/state errors and do **not** mark the endpoint as failed.

**Wire format.** `fetchChallenge(meta)` builds:
```jsonc
{
  "difficulty": "...", "client_type": "mcp",
  // Each block is included only when at least one field is populated:
  "agent": { ...AgentMeta },
  "integrator": { ...IntegratorMeta },
  "tags": { ... }
}
```
Empty blocks are dropped — keeps the wire payload clean for SDK callers that haven't captured agent info yet (e.g., challenge fetched before any tool call has fired the handshake hooks).

---

### `src/vps-router.ts`

**Purpose.** Endpoint selection + failover via IP-pinning. The fleet shares a single TLS hostname (`api.fdkey.com`) — every VPS holds an LE cert for that name, acquired via DNS-01 challenge so multiple boxes can hold valid certs simultaneously without HTTP-01 contention. The router fetches a list of IPs, probes each, picks fastest, and serves an undici dispatcher pinned to that IP. The SDK's HTTPS calls go to the chosen IP but present `api.fdkey.com` as TLS SNI — cert validation passes because the cert is for that name. Standard SDK-driven multi-region routing pattern (MongoDB driver, AWS regional pinning).

**Public exports.**
- `interface IVpsRouter` — `getTarget(): Promise<RoutingTarget>`, `recordFailure(ip: string | undefined): void`.
- `interface RoutingTarget` — `{ url: string; dispatcher?: Dispatcher; ip?: string }`. `url` is the constant URL the caller fetches (`https://api.fdkey.com` for VpsRouter; whatever the integrator passed for StaticRouter). `dispatcher` is an undici `Agent` with `connect.lookup` overridden to return the selected IP. `ip` is the IP for failure tracking.
- `class StaticRouter` — bypass discovery, use a single hardcoded URL with default DNS resolution (no IP pinning). Used when `FdkeyConfig.vpsUrl` is set (local dev, self-hosted).
- `class VpsRouter` — fetch IP list from Cloudflare CDN, parallel-probe each via HEAD `https://api.fdkey.com/health` pinned to that IP, sort by `(error_count ASC, latency ASC)`, cache for 1 hour between probes. Endpoint discovery cached for 7 days (stale-OK fallback if CDN unreachable).

**Imports (internal).** `./types.js` (`VpsEndpoint`).

**Imports (external).** `undici` (`Agent`, `fetch`, `Dispatcher`), `node:dns` (types only — `LookupOptions`).

**Imported by.** `index.ts`, `vps-client.ts`, `well-known.ts`.

**Constants.**
- `DEFAULT_DISCOVERY_URL = 'https://cdn.fdkey.com/endpoints.json'`
- `FDKEY_API_HOSTNAME = 'api.fdkey.com'` — every fleet member's TLS cert SAN
- `PROBE_INTERVAL_MS = 1h`
- `DISCOVERY_CACHE_TTL_MS = 7d`

**The IP-pin trick.** Each `Agent` instance has a custom `connect.lookup` that returns a fixed IP regardless of the hostname being resolved. Node 22+ may pass `opts.all = true` and expect the array form `[{address, family}]` rather than the legacy `(err, address, family)` triple — `vps-router.ts` supports both.

**Failover policy.** On 5xx or network error from a `VpsClient` request, the client calls `router.recordFailure(ip)`. The router increments that IP's error counter and (if it's the currently-selected one) clears `selected` so the next `getTarget()` call re-probes and may pick a different IP.

**Why undici over global `fetch`.** Node 18+ ships undici as the underlying fetch impl, but the bundled instance refuses dispatchers from a different undici version (npm-installed). Importing `fetch` directly from the npm-installed undici keeps the dispatcher and fetch in lock-step. Implementation detail; users of the SDK don't see it.

---

### `src/well-known.ts`

**Purpose.** Fetch and cache the FDKEY public key(s) from `${vpsBase}/.well-known/fdkey.json` for offline JWT verification.

**Public exports.**
- `class WellKnownClient` — `getKey(kid: string): Promise<KeyLike | null>`. Constructor takes a `() => Promise<string>` that returns the current VPS base URL (so it can route through the same `VpsRouter` as `VpsClient`).

**Imports (internal).** `./types.js` (`WellKnownPayload`).

**Imports (external).** `jose` (`importSPKI`, `KeyLike`).

**Imported by.** `index.ts`.

**Cache.** `Map<kid, KeyLike>` cached for 1 hour. On unknown kid (probably mid-rotation), refresh once before returning null.

**Side effects.** HTTP GET to the well-known endpoint. 5s timeout. Throws on non-2xx — JWT verification then surfaces as a verification failure.

---

## § 4 — Configuration reference (`FdkeyConfig`)

Every field of the integrator-supplied config object passed to `withFdkey(server, config)`.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `apiKey` | `string` (required) | — | Bearer token sent on every HTTP call to the VPS. Must match a `vps_users.key_sha256` row (or legacy `key_hash`) on the target VPS. |
| `protect` | `Record<string, ProtectEntry>` | `{}` | Tools that require verification, keyed by tool name. Each entry specifies a `policy`. Tools not listed are passed through unchanged. |
| `difficulty` | `'easy' \| 'medium' \| 'hard'` | `'medium'` | Forwarded to the VPS on `/v1/challenge`. Controls which puzzle types the VPS includes. |
| `onFail` | `'block' \| 'allow'` | `'block'` | What happens when verification fails (the agent doesn't pass the puzzle). `'allow'` lets traffic through anyway — useful for soft launches. |
| `onVpsError` | `'block' \| 'allow'` | `'block'` | What happens when the VPS is unreachable or returns 5xx. `'allow'` fails open — useful when FDKEY is a defense-in-depth layer rather than the only auth. |
| `inlineChallenge` | `boolean` | `false` | When true, blocked-tool errors embed the puzzle data so the agent can call `fdkey_submit_challenge` directly without a separate `fdkey_get_challenge` round-trip. |
| `vpsUrl` | `string` | `undefined` | Skip CDN discovery and use this VPS URL directly. Use for local dev (`http://127.0.0.1:3000`) or self-hosted FDKEY. When set, `StaticRouter` is used instead of `VpsRouter`. |
| `discoveryUrl` | `string` | `https://cdn.fdkey.com/endpoints.json` | Override the default endpoint discovery URL. Rare. |
| `tags` | `Record<string, string>` | `undefined` | Free-form key/value labels forwarded to the VPS on every challenge fetch. Stored under `vps_sessions.agent_info.tags`. **Bounded server-side** at 16 keys, 50-char keys (regex `^[A-Za-z0-9_]+$`), 200-char values — overflow returns HTTP 400. **Privacy:** documented as never-PII; integrators MUST NOT put end-user identity here. Useful for env labels, multi-tenant tagging, A/B experiments. |

---

## § 5 — Cross-cutting concerns

### Session-scoped state

A single `Map<string, SessionState>` lives in the `withFdkey` closure. Keyed by the MCP session id from `extra.sessionId`, falling back to the literal `'stdio'` for stdio-transport servers (which have a single implicit session per process). Per-session fields:

```
verified                        boolean
verifiedAt                      number | null            (ms epoch)
freshVerificationAvailable      boolean                  (consumed by each_call policy)
pendingChallengeId              string | null            (between get_challenge and submit_challenge)
lastClaims                      Record<string, unknown>  (decoded JWT, surfaced via getFdkeyContext)
clientInfo                      { name, version, title?, capabilities? } | null   (from MCP initialize)
protocolVersion                 string | null            (from initialize request params)
mcpSessionId                    string | null            (= extra.sessionId, or 'stdio')
transport                       'stdio' | 'http' | 'unknown'
```

### Agent identification capture chain

Three sources, three points in time:

1. **Compile-time constant** — `SDK_VERSION` in `index.ts` and `_serverInfo` from `McpServer`'s constructor, both forwarded as `integrator.{sdk_version, server_name, server_version}`.
2. **MCP `initialize` request** — captured by the `setRequestHandler(InitializeRequestSchema)` hook. Yields `protocol_version`. Synchronous, before any tool calls.
3. **MCP `notifications/initialized`** — captured by `oninitialized`. Yields `client_name`, `client_version`, `client_title`, `client_capabilities` from `server.server.getClientVersion()` + `getClientCapabilities()`. After 2 but before any tool calls.

`captureChallengeMeta(session, extra)` lazy-copies these into the session map on the first tool call (when we have `extra.sessionId` to key by). Idempotent via `??=` guards. `transport` is inferred from `extra.sessionId` presence.

The user-facing privacy contract is **explicitly documented**: capture is bounded to AI client metadata + integrator infra metadata + integrator-supplied non-user labels. Never prompts, never tool inputs/outputs, never end-user identity.

### MCP SDK private-API dependencies

The SDK currently reaches into three MCP TS SDK private members:

| Member | Why | Graceful degradation |
|---|---|---|
| `Server.oninitialized` | Public API (defined in d.ts). Hook for clientInfo + capabilities capture. | Fully supported. |
| `Server._serverInfo` | Read `name` / `version` for `integrator` block. | Optional-chained; if removed, those fields become undefined and the wire schema accepts that. |
| `Server._requestHandlers.get('initialize')` | Retrieve the original handler so we can capture `protocolVersion` from request params before delegating. | Optional-chained; if removed, the `setRequestHandler` override is skipped entirely and protocol_version stays null. The wire schema accepts that too. |

The bounded private-API surface is documented in the `withFdkey()` source comments. If an MCP TS SDK release breaks one of these, the SDK degrades by losing one optional capture field — never breaks initialize or any agent flow.

### JWT verification

After a successful submit, the VPS returns an Ed25519 JWT. The SDK:
1. Decodes the protected header to get `kid`.
2. Asks `WellKnownClient.getKey(kid)` for the matching public key (cached locally for 1h, refetched on cache miss).
3. Calls `jose.jwtVerify(jwt, key, { clockTolerance: 30 })` — 30s tolerance handles NTP drift between VPS and SDK host.
4. On success: caches decoded claims in `session.lastClaims` and calls `markVerified(session)`. The raw JWT is **never stored** — only the claims and the verified flag.
5. On failure: returns `{ verified: false, message: 'Verification failed: invalid JWT — …' }`. If `onFail: 'allow'`, marks verified anyway.

### Failure handling

| Failure | Behavior (with default config) | Override |
|---|---|---|
| Agent fails the puzzle (`verified: false` from VPS) | Block the original tool call. | `onFail: 'allow'` |
| VPS returns 5xx / network timeout | Block, `mkError('fdkey_service_unavailable: …')`. Tells `VpsRouter.recordFailure(host)` so the next call may try a different VPS. | `onVpsError: 'allow'` |
| VPS returns 4xx (e.g. `wrong_user`, `already_submitted`) | Treat as a verification failure (not an outage). Same as failed puzzle. | Same as `onFail`. |
| `challenge_expired` (special-cased) | Returns `{ verified: false, error: 'challenge_expired', message: 'Call fdkey_get_challenge to start a new one.' }`. Doesn't mark the endpoint as failed. | None — this is a normal client-state error. |
| JWT verification fails (bad signature, missing kid, etc.) | Block, return `{ verified: false, message: '... invalid JWT ...' }`. | `onFail: 'allow'` (skips JWT verify entirely). |

---

## § 6 — Public API surface

What an integrator imports and what an agent sees over MCP.

### What integrators import

```ts
import { withFdkey, getFdkeyContext, type FdkeyConfig, type Policy } from '@fdkey/mcp';

const server = withFdkey(new McpServer({ name: 'my-server', version: '1.0.0' }), {
  apiKey: process.env.FDKEY_API_KEY!,
  protect: {
    write_data: { policy: 'each_call' },
    read_data:  { policy: 'once_per_session' },
  },
  tags: { env: 'production', tenant: 'acme' },
});

server.registerTool('write_data', { /* ... */ }, async (args, extra) => {
  const ctx = getFdkeyContext(server, extra);
  // ctx.verified === true, ctx.claims has score/threshold/tier
  return { /* ... */ };
});
```

### What agents see over MCP

Two extra tools always visible on a wrapped server:

```
fdkey_get_challenge          (no args)
fdkey_submit_challenge       (args: { answers: Record<string, unknown> })
```

The `answers` schema is **opaque on purpose** — the SDK is puzzle-
agnostic; the literal wire shape comes from the challenge response itself
(`example_submission.tool_call_arguments`) and the VPS-rendered directive
in `mcp_response_text`. Adding a puzzle type or changing an answer format
does NOT require an SDK release.

Both tools carry stable MCP `annotations` (`title`, `readOnlyHint: false`,
`destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`)
so MCP clients can categorize them without re-fingerprinting on every
SDK release.

When a protected tool is called pre-verification, the agent gets a tool **error** (not a tool result):
```
"fdkey_verification_required. Call fdkey_get_challenge to start verification, then
 fdkey_submit_challenge with your answers, then retry this tool."
```

If `inlineChallenge: true`, the same error embeds the VPS-rendered
directive (the same `mcp_response_text` the `fdkey_get_challenge` tool
returns) so the agent can skip the round-trip.

### Wire format the SDK sends to the VPS

`POST /v1/challenge`:
```jsonc
{
  "difficulty": "medium",
  "client_type": "mcp",
  "agent": {
    "client_name": "claude-desktop",
    "client_version": "0.7.4",
    "client_title": "Claude Desktop",
    "client_capabilities": { "sampling": {}, "roots": { "listChanged": true } },
    "protocol_version": "2025-03-26",
    "mcp_session_id": "abc-123",
    "transport": "http"
  },
  "integrator": {
    "server_name": "my-server",
    "server_version": "1.0.0",
    "sdk_version": "0.1.0"
  },
  "tags": { "env": "production", "tenant": "acme" }
}
```
Each block is **only included when at least one field is populated** — old SDKs / cold-start sessions get a slim body. The VPS-side strict zod schema (see `vps/ARCHITECTURE.md` § 3 `routes/v1/challenge.ts`) is the source of truth for every field's bounds.

---

## § 7 — Maintenance protocol

> **Rule:** when you change `src/**` or `package.json`'s public surface, update this file.

### Checklist for common changes

```
[ ] Added a new field to AgentMeta / IntegratorMeta / ChallengeMeta?
    → src/types.ts: add to interface.
    → src/index.ts captureChallengeMeta(): populate from session/closure state.
    → vps/src/routes/v1/challenge.ts ChallengeBody: add to zod schema (bounded).
    → vps/ARCHITECTURE.md § 4 vps_sessions: extend agent_info shape doc.
    → ARCHITECTURE.md § 6 wire format: include in the example.

[ ] Added a new MCP-handshake hook?
    → src/index.ts: add the hook + closure-scope state.
    → ARCHITECTURE.md § 5 "Agent identification capture chain": document timing.
    → If it relies on a private MCP SDK member: add to "MCP SDK private-API
      dependencies" table with graceful-degradation note.

[ ] Added a new FdkeyConfig option?
    → src/types.ts FdkeyConfig: add field with JSDoc.
    → src/index.ts withFdkey: read + apply.
    → ARCHITECTURE.md § 4: add row.

[ ] Bumped version (preparing release)?
    → package.json "version" — bump.
    → src/index.ts SDK_VERSION constant — must match exactly. The
      "SDK_VERSION sync" test in src/index.test.ts asserts equality at
      every CI run; if it fails, fix the drift before merging.

[ ] Changed the wire format?
    → Coordinate with vps/ARCHITECTURE.md § 3 routes/v1/challenge.ts
      and § 4 vps_sessions agent_info shape. Both must reflect the same
      contract — cross-language single source of truth lives across both
      docs.
```

### Smoke test the doc still works

Suggested probes — answer using only this doc:

1. "Where is the SDK_VERSION constant defined and what does it do?" → § 3 `index.ts` (Internal constants).
2. "What policy options are available for protected tools?" → § 3 `guard.ts` (Policy semantics).
3. "What does the SDK send to the VPS on every challenge fetch?" → § 6 (Wire format) + § 5 (Agent identification capture chain).
4. "How does the SDK handle a VPS outage?" → § 5 (Failure handling table) + § 4 (`onVpsError`).
5. "Why does the SDK reach into MCP SDK private members and what happens if they change?" → § 5 (MCP SDK private-API dependencies table).
