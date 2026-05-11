# `@fdkey/http` — Architecture Reference

> **Purpose.** Drop-in FDKEY verification middleware for plain HTTP backends — Express, Fastify, Hono. Companion to `@fdkey/mcp` for any backend that exposes a REST/HTTPS API rather than an MCP server.
>
> **Last verified against:** `src/` as of 2026-05-11 (0.3.0).
>
> **What's new since 0.2.x** (the previous reference baseline):
> - **0.3.0** — HMAC-signed challenge tickets close the open
>   `/fdkey/challenge` endpoint. The 402 response gains a
>   `challenge_ticket` field; `/fdkey/challenge` and `/fdkey/submit`
>   now require `Authorization: Bearer <ticket>` (401 otherwise).
>   Tickets are short-lived (default 5 min), bound to the minted
>   session id, and stateless (HS256 via `jose`). New required config
>   field `ticketSecret`. New module `src/ticket.ts`. Submit
>   additionally enforces ticket-sid == cookie-sid; mismatch returns
>   `fdkey_ticket_session_mismatch`.
>
> Prior baseline (0.1.x – 0.2.1): session-mediated flow; agent never
> holds a JWT; cookie/header/custom session strategies; Express,
> Fastify, Hono adapters; browser widget at `@fdkey/http/client`.
>
> **Companion docs.**
> - [../typescript/ARCHITECTURE.md](../typescript/ARCHITECTURE.md) — `@fdkey/mcp` (the MCP-native sibling); shares the JWT verify logic and the wire format.
> - [../../../vps/ARCHITECTURE.md](../../../vps/ARCHITECTURE.md) — VPS scoring server. Already supports `client_type: 'rest'` and ships generic JWTs; **no VPS code changes required for this package**.

---

## § 1 — Top-level

`@fdkey/http` gates plain-HTTP routes behind FDKEY verification using a **session-mediated flow** that mirrors the design philosophy of `@fdkey/mcp` ("the connection IS the session"). The connecting AI agent **never holds a JWT** — it holds only a session id (a cookie or a custom header). The JWT lives entirely server-side as a verification artifact: verified once on receipt, decoded into `{ verifiedAt, score, tier, claims }`, stored, and discarded.

Why this matters versus the more obvious "Bearer JWT to agent" pattern:

- **No replay surface.** The agent has no token to leak, no token to forward to a different FDKEY-protected service.
- **No cross-integrator JWT replay caveat** — the JWT never leaves this server.
- **Matches the mental model** an integrator builds when they ship FDKEY for the first time: "verify once, the user is now logged in until I decide otherwise" — same as session cookies for human auth.
- **No agent-side token plumbing.** Agents browsing a website with a rendered "register as AI agent" UI just click + solve + go; they don't need to attach a Bearer header on subsequent requests.

### The exact flow (HTTP wire-level)

```
Agent → GET /api/protected
   ↓ middleware sees no verified session
HTTP 402 with challenge embedded
   Set-Cookie: fdkey_session=<uuid>; HttpOnly; Secure; SameSite=Lax
   Body: { ..., challenge_ticket: "<HS256 JWT, sid-bound, 5-min TTL>" }
   ↓ agent solves the puzzles
Agent → POST /fdkey/submit  (mounted by the SDK on the integrator's server)
   Cookie: fdkey_session=<same-uuid>
   Authorization: Bearer <challenge_ticket>
   Body: { challenge_id, answers }
   ↓ SDK: verify ticket → check ticket.sid == cookie sid → forward
SDK forwards to api.fdkey.com/v1/submit using integrator's API key
   ↓ VPS scores, returns { verified, jwt }
SDK verifies JWT offline against the well-known
   ↓ stores { verifiedAt, score, tier, claims } in the session store
Returns to agent: { verified: true, score, tier }   ← no JWT in body
   ↓
Agent → GET /api/protected (retry with same cookie — no ticket needed here)
   ↓ middleware looks up session → req.fdkey populated
handler runs
```

### Ticket lifecycle (0.3.0+)

The SDK issues a **short-lived HMAC-signed ticket** on every 402 and
requires it back on `/fdkey/challenge` and `/fdkey/submit`. This closes
the abuse vector where random scripts could hit `/fdkey/challenge`
indefinitely, burning the integrator's VPS quota without ever
interacting with a protected route.

- **Format.** Compact JWS (JWT), HS256. Claims: `iat`, `exp`, `sid`,
  `iss: "fdkey-http-sdk"`. Signed with `FdkeyHttpConfig.ticketSecret`
  (required, min 32 bytes).
- **TTL.** Default 300s (5 min); configurable via `ticketTtlSeconds`.
  Long enough for a slow agent to fetch, solve, retry, and submit;
  short enough that a leaked ticket isn't a long-lived authorization.
- **Reusable within TTL.** Not single-use — an agent that refreshes
  the challenge then submits uses the same ticket twice. Simpler than
  one-time semantics; doesn't need server-side revoke storage.
- **Session binding.** The `sid` claim is the freshly-minted session
  id. On submit, the ticket sid must match the cookie/header sid;
  mismatch returns 401 `fdkey_ticket_session_mismatch`. This prevents
  an attacker from replaying a ticket from one session against another.
- **Stateless.** No server-side ticket storage; verification is pure
  HMAC + claim check. Works across multi-process / multi-region
  deployments without coordination.
- **The middleware path doesn't require a ticket** — the protected
  route is the entry point that *issues* tickets. Only `/fdkey/challenge`
  and `/fdkey/submit` enforce them.

See `src/ticket.ts` for the signing/verifying primitives.

### Why the integrator's API key never reaches the agent

The VPS endpoints `/v1/challenge` and `/v1/submit` both require `Authorization: Bearer <integrator_api_key>` (`requireUserKey` preHandler in `vps/src/routes/v1/{challenge,submit}.ts`). If the agent posted directly to `api.fdkey.com/v1/submit`, it would either need the API key (impossible — that's the integrator's secret) or the VPS would have to support unauthenticated submit, which it doesn't.

The SDK acts as the API-key holder for both VPS calls (challenge fetch + submit forward). The agent only ever talks to the integrator's server.

---

## § 2 — Directory map

```
mcp-integration/sdks/http/
├─ src/
│  ├─ index.ts            — Public API: createFdkey() factory + per-framework
│  │                         adapters (express, fastify, hono). The
│  │                         framework-agnostic core (gateRequest,
│  │                         processSubmit, processChallengeFetch) lives here
│  │                         too — adapters are thin wrappers that translate
│  │                         { status, body, headers? } into the framework's
│  │                         response shape.
│  ├─ types.ts            — FdkeyHttpConfig, FdkeyContext, VerifiedSession,
│  │                         SessionStore, ChallengeRequiredResponse,
│  │                         SessionStrategy, etc.
│  ├─ session-store.ts    — InMemorySessionStore (default). Bounded LRU+TTL,
│  │                         async API. Mirrors @fdkey/mcp's session-store
│  │                         byte-for-byte (1h idle TTL, 10k LRU cap).
│  ├─ session-id.ts       — Cookie / header / custom strategies. Reads the
│  │                         raw `Cookie:` header (no cookie-parser dep);
│  │                         writes Set-Cookie ourselves with HttpOnly +
│  │                         Secure + SameSite=Lax.
│  ├─ vps-client.ts       — Server-to-server calls to api.fdkey.com.
│  │                         fetchChallenge() → puzzle JSON.
│  │                         submitAnswers(challenge_id, answers) → { verified, jwt }.
│  │                         buildChallengeRequiredResponse() shapes the 402.
│  ├─ jwt-verify.ts       — Internal Ed25519 verify against the well-known.
│  │                         Returns the VerifiedSession (verifiedAt, score,
│  │                         tier, claims) or null on any failure.
│  ├─ well-known.ts       — { kid → KeyLike } cache, 1h TTL, refreshes on
│  │                         unknown kid (mid-rotation handling).
│  ├─ policy.ts           — once_per_session | every_minutes: N
│  │                         normalisePolicy + sessionStillValid(policy, ts, now).
│  └─ index.test.ts       — 15 tests covering: 402 + Set-Cookie on first
│                            contact, full submit round-trip with Ed25519
│                            sign-verify, session-mediated middleware
│                            pass-through, policy expiration, header
│                            strategy, custom session store, VPS-error
│                            paths (block + allow), Hono adapter parity.
├─ dist/                   — tsc output, shipped to npm via package.json `files`.
├─ package.json            — name @fdkey/http, deps: jose + zod.
├─ tsconfig.json           — Strict TS, ESM target, Node16 module resolution.
├─ vitest.config.ts        — Test harness config.
├─ README.md               — Install + usage examples (Express, Fastify, Hono).
├─ LICENSE                 — MIT.
└─ ARCHITECTURE.md         — This file.
```

---

## § 3 — Per-file detail

### `src/index.ts`

**Purpose.** Public factory + framework adapters + the framework-agnostic core handlers.

**Public exports.**
- `createFdkey(config: FdkeyHttpConfig): FdkeyInstance` — the entry point. Returns an object with `.express`, `.fastify`, `.hono` adapter namespaces and the underlying `.sessionStore`.
- `InMemorySessionStore` — default store, also exported for tests / explicit construction.
- All public types from `types.ts` (`FdkeyHttpConfig`, `FdkeyContext`, `VerifiedSession`, `SessionStore`, `ChallengeRequiredResponse`, `ChallengeReason`, `SessionStrategy`, `SubmitRequest`, `SubmitResponse`, `Policy`, `PolicyShorthand`).

**Internal layout.**
- `buildCore(config)` resolves all defaults and constructs the per-instance state bag (`{ config, sessionStore, vps, jwt }`).
- Framework-agnostic core handlers each take the `core` and return abstract `{ status, body, headers? }`:
  - `gateRequest(core, headers)` — middleware check; returns `{ outcome: 'pass', context }` or `{ outcome: 'block', response }`.
  - `processSubmit(core, headers, body)` — handles POST /fdkey/submit.
  - `processChallengeFetch(core)` — handles GET /fdkey/challenge.
  - `blockWithChallenge(core, sid, mintedNew, reason)` — fetches a challenge from VPS and shapes it into a 402.
- `makeExpress(core)`, `makeFastify(core)`, `makeHono(core)` are thin adapters that translate the abstract responses into framework-native calls.

**Why a single file?** Because the framework-agnostic core is the contract — anything that's framework-specific is just a translation layer. Splitting them by framework would duplicate the core; bundling per-framework would force users to import a path. Keeping it together with lazy getters (`get express()`) gives users zero-cost-when-unused adapters.

---

### `src/types.ts`

Public types only.

- `FdkeyHttpConfig` — what the integrator passes to `createFdkey()`. `apiKey` is required; everything else has a default.
- `FdkeyContext` — what's attached to `req.fdkey` (Express/Fastify) or `c.var.fdkey` (Hono) when verified. Carries `sessionId`, `verifiedAt`, `score`, `tier`, `claims`.
- `VerifiedSession` — what gets stored in the SessionStore. Same fields minus `sessionId` (the session's own key is the sid; storing it inside would be redundant).
- `SessionStore` — async interface with `get/set/delete`. The default implementation just `Promise.resolve()`s its returns; integrators can wire in Redis natively.
- `ChallengeRequiredResponse` — the 402 body shape. Carries a `submit_url` field (always points at the integrator's `/fdkey/submit`, NOT api.fdkey.com — agents must POST locally because they have no API key).
- `ChallengeReason` — `'no_session' | 'unknown_session' | 'expired_session'` for 402 observability.
- `SessionStrategy` — `'cookie' | 'header' | { extract, attach? }`.
- `SubmitRequest` / `SubmitResponse` — the agent-facing wire shape for /fdkey/submit. Critically, `SubmitResponse` does NOT include a JWT field.

---

### `src/session-store.ts`

`InMemorySessionStore` — the default `SessionStore` implementation. Bounded along two dimensions:

1. **Idle TTL on insert** — when a brand-new entry arrives, the head of the map (LRU by insertion order) is checked: if it has been idle longer than `idleTtlMs` (default 1 h), it's dropped. O(1) per insert.
2. **Hard cap on insert** — when `entries.size === maxSize` (default 10 k), the head is force-dropped. O(1).

`get()` slides the LRU position to the tail (delete + re-insert). `set()` does the same. `delete()` is plain. `size()` is for tests/instrumentation.

Memory ceiling: 10 k × ~200 bytes ≈ 2 MB max regardless of churn. Same shape as `@fdkey/mcp`'s session-store — coordinated so future improvements land symmetrically.

---

### `src/session-id.ts`

`resolveSessionId(strategy, cookieName, headers, mintNew)` — pulls or mints a session id for the current request. Returns `{ sid, minted }`; `minted: true` tells the caller to surface the new id (Set-Cookie for `'cookie'`, custom `attach()` for `{ extract, attach }`, none for `'header'`).

`buildSetCookieValue(name, value, maxAgeSeconds)` — `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`. Hardcoded security defaults — see the README's HTTPS-only warning.

`mintSessionId()` — `crypto.randomUUID()` when available (Node 19+, Workers, Bun, Deno), otherwise a 32-char hex fallback.

`getHeader(headers, name)` — case-insensitive header read, accepting either Express-style plain object or Web `Headers`.

---

### `src/vps-client.ts`

`VpsClient` — server-to-server HTTP client for `api.fdkey.com`. Holds the integrator's API key; sends it on every request via `Authorization: Bearer ...`.

- `fetchChallenge()` POSTs `/v1/challenge` with `{ difficulty, client_type: 'rest', tags? }`. Returns the puzzle JSON.
- `submitAnswers(challenge_id, answers)` POSTs `/v1/submit` with `{ challenge_id, answers }`. Returns `{ verified, jwt, ... }`.
- `buildChallengeRequiredResponse(challenge, reason, submitUrl)` shapes the 402 response — including `submit_url` pointing at the integrator's local route.

`VpsHttpError` is thrown for non-2xx with `status` and parsed body. The middleware branches on `status >= 500` (treat as VPS down) vs `status >= 400` (treat as client/state error like `challenge_expired`).

---

### `src/ticket.ts` (new in 0.3.0)

`signTicket(secretBytes, sid, ttlSeconds?)` and
`verifyTicket(secretBytes, token)` using `jose`'s `SignJWT` /
`jwtVerify` with HS256. Errors:

- `TicketExpiredError` (code `fdkey_ticket_expired`) — token past
  its `exp` claim.
- `TicketInvalidError` (code `fdkey_ticket_invalid`) — anything else
  (bad signature, malformed JWT, wrong issuer, missing claims).

`secretToBytes(s)` is a thin `TextEncoder` wrapper exported alongside
so `buildCore()` can pre-encode the secret once at startup and keep
the hot path off `new TextEncoder()` per request.

Constants:

- `DEFAULT_TICKET_TTL_SECONDS = 300` — 5 min default.
- `MIN_TICKET_SECRET_BYTES = 32` — HS256 minimum (256-bit hash output).

Used by `index.ts` in `buildCore()` (pre-encode secret),
`blockWithChallenge()` (sign on 402), and `requireValidTicket()`
(verify on `/fdkey/challenge` and `/fdkey/submit`).

---

### `src/jwt-verify.ts`

`JwtVerifier.verify(token)` — flow:
1. `decodeProtectedHeader(token)` → `kid`.
2. `wellKnown.getKey(kid)` → `KeyLike`.
3. `jose.jwtVerify(token, key, { clockTolerance: 30 })` — 30 s leeway for NTP drift between VPS and integrator host.
4. `decodeJwt(token)` → claims dict.
5. Returns `VerifiedSession` `{ verifiedAt: now, score, tier, claims }`. Defaults `score: 0, tier: ''` if either field is wrong-typed in the claims (defensive — shouldn't happen, but doesn't crash if VPS issues a malformed JWT).

Returns `null` on any failure. Middleware treats null as "verification failed even though VPS said pass" (kid-rotation race or misconfigured VPS).

---

### `src/well-known.ts`

`WellKnownClient.getKey(kid)`:
1. Cache hit and not expired → return.
2. Cache hit but `kid` not present → refresh once, then return whatever the refresh produced (or null).
3. Cache miss → refresh, then return.

Cache TTL: 1 h. Fetch timeout: 5 s.

---

### `src/policy.ts`

`Policy` is `{ type: 'once_per_session' } | { type: 'every_minutes'; minutes: number }`.

`sessionStillValid(policy, verifiedAtMs, nowMs)`:
- `once_per_session`: always true.
- `every_minutes: N`: true if `nowMs - verifiedAtMs < N * 60_000`.

`normalisePolicy()` accepts the string shorthand `'once_per_session'` or a full object.

**`each_call` is intentionally NOT supported.** For HTTP it would mean every API call requires a fresh puzzle solve, making the API unusable. If you want stricter guarantees, lower the JWT lifetime VPS-side (`vps_users.jwt_lifetime_seconds`) or use `every_minutes: 1`.

---

## § 4 — Configuration reference (`FdkeyHttpConfig`)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `apiKey` (required) | `string` | — | Integrator's VPS API key. **NEVER sent to the agent.** Used server-to-server only. |
| `vpsUrl` | `string` | `https://api.fdkey.com` | Override for self-hosted FDKEY. |
| `difficulty` | `'easy' \| 'medium' \| 'hard'` | `'medium'` | Forwarded to the VPS. |
| `policy` | `'once_per_session' \| { type: 'every_minutes'; minutes: N }` | `'once_per_session'` | Re-verification policy. |
| `onVpsError` | `'block' \| 'allow'` | `'block'` | What to do when VPS is unreachable. `block` → 503; `allow` → pass through with no `req.fdkey`. |
| `tags` | `Record<string, string>` | `undefined` | Forwarded to FDKEY for analytics. |
| `sessionStrategy` | `'cookie' \| 'header' \| { extract, attach? }` | `'cookie'` | How sessions are identified across requests. |
| `cookieName` | `string` | `'fdkey_session'` | Cookie name for the cookie strategy. |
| `cookieMaxAgeSeconds` | `number` | `86400` (24 h) | Set-Cookie Max-Age. |
| `sessionStore` | `SessionStore` | `new InMemorySessionStore()` | Override for distributed deployments (Redis-backed etc). |
| `submitPath` | `string` | `'/fdkey/submit'` | Where the agent POSTs its answers. |
| `challengePath` | `string` | `'/fdkey/challenge'` | Optional convenience GET endpoint for integrator UIs. |

---

## § 5 — Cross-cutting concerns

### Forward-compat capability score

`FdkeyContext.score` is a 0..1 float reserved for graduated capability scoring. Today the VPS issues effectively-binary values (1.0 = passed, 0.0 = failed). The future graduated scoring (combined T1 correctness + T3 tau + T4-T6 frequency) lands without an API change.

### What the package DOES NOT do

- It does not see request bodies, query params, or response bodies — only the `Cookie` / `Authorization` / `X-FDKEY-Session` headers.
- It does not see the end users of your API.
- It does not perform any cryptographic operation against integrator-owned data — only verifies our own JWTs.
- It does not give the agent a token. Ever.

### Failure modes

| Failure | Behavior (default config) | Override |
|---|---|---|
| No session id on request | 402 with `reason: 'no_session'` + Set-Cookie | None — this is the intended onboarding flow. |
| Session id present but unknown | 402 with `reason: 'unknown_session'` (no new Set-Cookie) | None. |
| Session expired by `every_minutes` policy | 402 with `reason: 'expired_session'` | Adjust the policy. |
| VPS unreachable when fetching challenge | 503 `fdkey_service_unavailable` | `onVpsError: 'allow'` (request proceeds, no `req.fdkey`) |
| VPS returns 4xx on submit (e.g. challenge_expired) | 200 `{ verified: false, message }` | None — surface to agent as natural retry signal. |
| VPS returns `verified: true` but JWT signature invalid | 200 `{ verified: false, message: 'JWT verification failed' }` — session NOT marked verified | None. Defense in depth against misconfigured VPS. |

### Cross-runtime support

This package targets Node 18+ (declared in `engines.node`) and runs unchanged on Bun, Deno, and Cloudflare Workers. Uses the global `fetch`, `AbortSignal.timeout`, `crypto.randomUUID` (with hex fallback), and Web Crypto via `jose`. The framework adapters (Express/Fastify) are Node-only by their nature, but the Hono adapter works on edge runtimes including Workers.

---

## § 6 — Maintenance protocol

> **Rule:** when you change `src/**` or `package.json`'s public surface, update this file.

Common changes:
- New field on `FdkeyContext` / `VerifiedSession`? → `types.ts` + matching field in `@fdkey/mcp`'s `FdkeyContext` for parity. README "What req.fdkey carries" section.
- New `Policy` variant? → `policy.ts` (exhaustive switch). Same change in `@fdkey/mcp`'s `guard.ts`.
- New `client_type` value? → `vps-client.ts` `fetchChallenge`. Coordinate with `vps/src/routes/v1/challenge.ts:26` zod enum (source of truth).
- Bumped version? → `package.json`. No code-side version constant in this package.
- Changed the 402 body shape? → `types.ts` (`ChallengeRequiredResponse`). README "What the agent sees" section. **Don't drop existing fields** without bumping the major version — agents-in-the-wild parse this.
