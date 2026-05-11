# Changelog

All notable changes to `@fdkey/http` will be documented in this file.

## 0.3.0 — 2026-05-11

### Added — HMAC-signed challenge tickets (closes the abuse vector on `/fdkey/challenge`)

`/fdkey/challenge` and `/fdkey/submit` now require a short-lived
**Bearer ticket** issued by the SDK's 402 path. Without one, both
endpoints return 401. Random scripts that hit those endpoints without
ever going through a protected route are blocked at the front door —
the integrator's quota isn't burned, the VPS isn't asked for a
challenge, and there's no path for a hostile client to spin
indefinitely on the verification surface.

**Wire format:**

- New required config field: `ticketSecret: string` (min 32 bytes).
  Generate with `openssl rand -base64 48` and store as a server-side
  secret (env var, Wrangler secret, etc.). Never exposed to the agent.
- New optional config field: `ticketTtlSeconds?: number` (default 300
  = 5 min). Long enough for a slow agent to fetch, solve, and submit;
  short enough that a leaked ticket isn't a long-lived authorization.
- New field on the 402 response body: `challenge_ticket: string`.
  Compact JWS (JWT, HS256) bound to the freshly-minted session id.
- New required header on `GET /fdkey/challenge` and `POST /fdkey/submit`:
  `Authorization: Bearer <ticket>`. The submit handler additionally
  enforces that the ticket's sid matches the cookie/header sid; ticket
  replay across sessions returns 401 `fdkey_ticket_session_mismatch`.

**New 401 error codes** (under `error` in the body):

- `fdkey_ticket_required` — no Authorization header.
- `fdkey_ticket_expired` — ticket past its `exp`.
- `fdkey_ticket_invalid` — bad signature, malformed JWT, wrong issuer,
  or missing claims.
- `fdkey_ticket_session_mismatch` — ticket sid != session cookie sid
  on submit.

**Why HMAC tickets, not just session-id reuse:** the session id is a
stable, long-lived (24h cookie) identifier — using it as the gate
would mean an attacker who scraped a session id once could hammer
`/fdkey/challenge` for the full lifetime of that session. Tickets
separate "who you are" (session, long-lived) from "you're in an
active verification window right now" (ticket, ~5 min). Stateless —
no server-side storage of tickets; verification is pure HMAC.

**Implementation:** new module `src/ticket.ts` (`signTicket`,
`verifyTicket`, `TicketExpiredError`, `TicketInvalidError`) uses
`jose` HS256 — no new deps. Validation order on submit: ticket
check → session-id resolve → ticket-sid vs session-sid match → body
shape → VPS relay.

### Breaking

- **`ticketSecret` is now required at `createFdkey()` startup.** The
  SDK throws an actionable error if it's missing or shorter than 32
  bytes. There's no opt-out — the previous "open `/fdkey/challenge`"
  behavior was a security regression we're closing for everyone.
- **`/fdkey/challenge` and `/fdkey/submit` now reject requests
  without a Bearer ticket** with 401. Agents that previously hit
  those endpoints directly need to go through a protected route
  first to receive a 402 + ticket.

### Migration

For an integrator on 0.2.x:

```ts
// Before:
const fdkey = createFdkey({ apiKey: process.env.FDKEY_API_KEY! });

// After (one new required line):
const fdkey = createFdkey({
  apiKey: process.env.FDKEY_API_KEY!,
  ticketSecret: process.env.FDKEY_TICKET_SECRET!, // openssl rand -base64 48
});
```

If you depend on direct `/fdkey/challenge` fetches (e.g. a browser
widget on a marketing site that wants a puzzle without first hitting
a protected route), you'll need to either: route through a protected
endpoint first to get a ticket, OR keep the widget on 0.2.x until
you add a server-side "issue a demo ticket" endpoint of your own.

## 0.2.1 — 2026-05-10

### Changed — widget UX

- **`requireStart` defaults to `true` now.** Widget renders a "Start
  FDKEY challenge" button by default, so visitors / agents see the
  card before the timer ticks. Set `requireStart: false` for fully
  autonomous flows where the agent reads + submits without UI
  interaction.
- **Retry button after every verdict.** Both pass and fail verdicts
  surface a retry control that re-mounts the widget on the same
  container with the same opts. Useful for demo pages and for genuine
  service-error recovery.
- **Retry available on "service unreachable" too** — transient
  outages are recoverable without page reload.
- **Defensive container check.** `fdkeyChallenge(null, ...)` now
  throws a clear `Error('container must be an HTMLElement')` instead
  of a cryptic TypeError on the next DOM call.
- **Distinguish SDK-side 4xx from VPS-side outage** in the error UI.
  When the SDK returns 503 with `fdkey_unexpected_4xx` (the Phase 2
  client-bug path), the widget now says "Verification failed —
  integrator/SDK bug" instead of "service unreachable", which is the
  accurate diagnosis.

### Tests

- 52/52 pass (no new tests added — UX changes; existing dispatch
  coverage protects the data-flow contract).

## 0.2.0 — 2026-05-10

### Added — browser widget

- **`@fdkey/http/client`** is a new subpath export. Drop a `<div>`,
  call `fdkeyChallenge(div, { endpoint: '/api/fdkey' })`, the widget
  fetches a challenge, renders the puzzles, accepts user input
  (typically an LLM agent), submits, and resolves with the verdict.
  Total integrator code: ~5 lines.
- **Data-driven renderer dispatch.** When the VPS ships a new puzzle
  type whose JSON shape matches an existing pattern, the widget
  renders it automatically — no SDK update needed. Patterns:
  - `questions: [...]` → MCQ renderer
  - `concept` + `options[]` → ranking renderer (T3)
  - `prompt: string` → freeform renderer (reserved for T4-T6)
  - Anything else → fallback: dump JSON + generic textarea so the
    agent can still read it.
- **Semantic HTML, agent-readable.** The primary consumer is an LLM
  agent (Playwright/browser-use/computer-use driver). Puzzles render
  as `<article>` blocks with `<input name="typeN[i].answer">`-style
  form elements and `<p class="fdkey-instructions">` text verbatim
  from the VPS. CSS is bonus.
- **Default styles included.** Class names use `.fdkey-` prefix; pass
  `defaultStyles: false` to opt out and bring your own.
- **Submit URL from VPS.** Widget reads `submit_url` from the challenge
  response — adapts when the SDK is mounted at a non-root path.
- New `dist/client/` build target compiled via `tsconfig.client.json`
  (browser-targeted ES2022, DOM lib).
- Tests: 9 new dispatch tests covering all 4 renderer patterns +
  contract assertions. Full DOM-level rendering is validated via the
  live demo at fdkey.com.

### Changed

- `package.json` `exports` map gains `./client` subpath.
- `scripts.build` now runs BOTH the server (`tsc`) and client
  (`tsc -p tsconfig.client.json`) builds.

## 0.1.2 — 2026-05-10

### Changed — behavior

- **`onVpsError` fail-open narrowed to true outages.** The SDK no
  longer fail-opens on VPS 4xx responses (`invalid_body`, 422, 404,
  etc.). Per the README contract — "If the FDKEY scoring service is
  unreachable, the SDKs default to fail-open" — only network errors
  and 5xx responses count as "unreachable". 4xx means the VPS is
  working and your request is malformed; the SDK now always returns
  503 with `error: 'fdkey_unexpected_4xx'` for these, regardless of
  `onVpsError`.
- Pre-0.1.2 behavior leaked fake-pass verdicts when the SDK sent a
  malformed body — the VPS rejected with 400, the SDK saw a 4xx
  it didn't recognize, and `onVpsError: 'allow'` synthesized a
  verified-but-`score:0` session. This was the exact opposite of
  the documented intent and could let a buggy integrator silently
  admit unverified traffic. Existing 401/403 handling (always loud,
  bad API key) and agent-facing 4xx handling (`challenge_expired`
  → `verified: false`) are unchanged.
- The companion `vps/src/routes/v1/submit.ts` Zod schema was
  loosened on the same day so the VPS rarely returns 4xx for
  empty/garbage answers anymore — they're scored as `verified:
  false` instead. So this code path mostly fires for genuine
  protocol violations now.

### Tests

- New regression test: VPS 400 `invalid_body` → SDK 503
  `fdkey_unexpected_4xx`, no synthetic session minted, even with
  `onVpsError: 'allow'`.

## 0.1.1 — 2026-05-10

### Documentation

- README now correctly states `onVpsError` defaults to `'allow'`
  (fail-open). The 0.1.0 README incorrectly claimed `'block'` was the
  default, which would have led integrators to design fail-closed
  handlers based on a mismatched assumption. Code behavior unchanged
  — the default has always been `'allow'`.
- "If you want strict consistency" paragraph clarified for the
  `onVpsError: 'block'` path: middleware returns 503 AND `/fdkey/submit`
  returns 503, so handlers never see a synthetic session.

No code changes. Republishing to align registry README with the
actual code behavior.

## 0.1.0 — 2026-05-09

Initial public release. Plain-HTTP middleware for Express, Fastify,
and Hono. Session-mediated flow — agent never holds a JWT.
