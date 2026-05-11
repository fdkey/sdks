# @fdkey/http

> **FDKEY verification middleware for plain HTTP backends.** Gate your REST
> routes behind LLM-only puzzles. The connecting AI agent **never holds a
> token** — verified state lives in your server's session, exactly like the
> [`@fdkey/mcp`](https://www.npmjs.com/package/@fdkey/mcp) MCP middleware.
> Drop-in adapters for Express, Fastify, and Hono.

## Who this is for

You run a website or HTTP API that AI agents visit and you want to gate some
of it behind "prove you're a capable LLM" — register-as-agent flows, post
endpoints on agent-only social networks, agent-callable trading APIs,
marketplaces, anything where you'd otherwise see scripted abuse. You install
this SDK on **your** server, configure which routes are protected, and ship.
The agents that hit your site can be anything — a developer-written Python
script using the Anthropic SDK, an autonomous framework like LangChain or
Devin, a ChatGPT Custom GPT pointed at your OpenAPI, a Claude Desktop user
with an MCP connector to your site, or a headless browser-using model. You
don't need to know which; you only need to know that the protocol below
works for any of them. **This SDK is not for AI agent operators** — it's
for the website operator on the receiving end.

## How the flow works

```
Agent → GET /api/protected                                (step 1)
   ↓ middleware sees no verified session
HTTP 402 with embedded challenge + HMAC ticket
   Set-Cookie: fdkey_session=<sid>                        ← session id (cookie)
   X-FDKEY-Session: <sid>                                 ← same id (header, for cookieless agents)
   Body: { puzzles, challenge_id, challenge_ticket, ... } ← ticket: HS256 JWT, ~5min TTL, bound to sid
   ↓ agent solves the puzzles
Agent → POST /fdkey/submit                                (step 2)
   Cookie: fdkey_session=<sid>   OR   X-FDKEY-Session: <sid>
   Authorization: Bearer <challenge_ticket>
   Body: { challenge_id, answers }
   ↓ SDK: verify ticket; check ticket.sid == cookie/header sid
   ↓ SDK forwards to api.fdkey.com using YOUR API key (server-to-server)
   ↓ SDK verifies the returned JWT offline against the well-known
   ↓ SDK marks the session verified in your session store
{ verified: true, score, tier }   ← no JWT in body, agent never sees one
   ↓
Agent → GET /api/protected                                (step 3, retry)
   Cookie: fdkey_session=<sid>   OR   X-FDKEY-Session: <sid>
   ↓ middleware looks up session → req.fdkey populated
your handler runs
```

The agent only holds a **session id** (cookie or custom header) and a
**short-lived ticket** (the HMAC JWT from step 1, only needed for steps
2–3). The full JWT issued by the FDKEY VPS is server-side only — verified
once on receipt, decoded into `{ verifiedAt, score, tier, claims }`,
stored, and discarded. The agent never sees it.

## Install

```bash
npm install @fdkey/http
```

Get an API key at [app.fdkey.com](https://app.fdkey.com).

## Quick start (Express)

```ts
import express from 'express';
import { createFdkey } from '@fdkey/http';

const app = express();
app.use(express.json());

const fdkey = createFdkey({
  apiKey: process.env.FDKEY_API_KEY!,
  // Required since 0.3.0 — HMAC secret for short-lived agent tickets.
  // Generate with `openssl rand -base64 48` and store as a server secret.
  ticketSecret: process.env.FDKEY_TICKET_SECRET!,
  policy: 'once_per_session',  // or { type: 'every_minutes', minutes: 15 }
});

// 1. Mount the SDK's submit + challenge endpoints. The agent posts here —
//    NEVER directly to api.fdkey.com (it has no API key, the VPS rejects).
app.use(fdkey.express.routes());

// 2. Gate any path you want.
app.use('/api/protected', fdkey.express.middleware());

app.get('/api/protected/whoami', (req, res) => {
  // req.fdkey is { sessionId, score, tier, claims, verifiedAt } — first-class.
  res.json({ verified: true, score: req.fdkey?.score, tier: req.fdkey?.tier });
});

// Optional: type augmentation so `req.fdkey` type-checks.
declare global {
  namespace Express {
    interface Request {
      fdkey?: import('@fdkey/http').FdkeyContext;
    }
  }
}
```

## Fastify

```ts
import Fastify from 'fastify';
import { createFdkey } from '@fdkey/http';

const app = Fastify();
const fdkey = createFdkey({
  apiKey: process.env.FDKEY_API_KEY!,
  ticketSecret: process.env.FDKEY_TICKET_SECRET!,
});

fdkey.fastify.registerRoutes(app);
app.addHook('preHandler', fdkey.fastify.preHandler());

app.get('/api/protected', async (req) => ({
  score: req.fdkey?.score,
}));

declare module 'fastify' {
  interface FastifyRequest {
    fdkey?: import('@fdkey/http').FdkeyContext;
  }
}
```

## Hono

```ts
import { Hono } from 'hono';
import { createFdkey, type FdkeyContext } from '@fdkey/http';

type Variables = { fdkey: FdkeyContext };
const app = new Hono<{ Variables: Variables }>();

const fdkey = createFdkey({
  apiKey: process.env.FDKEY_API_KEY!,
  ticketSecret: process.env.FDKEY_TICKET_SECRET!,
});
fdkey.hono.registerRoutes(app);
app.use('/api/*', fdkey.hono.middleware());

app.get('/api/whoami', (c) => {
  const f = c.get('fdkey');
  return c.json({ verified: true, score: f.score, tier: f.tier });
});
```

## What the agent sees

```http
GET /api/protected/foo
→ HTTP/1.1 402 Payment Required
  Set-Cookie: fdkey_session=<uuid>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400
  Content-Type: application/json

  {
    "error": "fdkey_verification_required",
    "reason": "no_session",
    "challenge_id": "...",
    "expires_at": "...",
    "expires_in_seconds": 300,
    "puzzles": { "type1": [...], "type3": {...} },
    "submit_url": "/fdkey/submit",
    "challenge_ticket": "eyJhbGciOiJIUzI1NiI...",     // ← NEW in 0.3.0
    "hint": "Solve the puzzles, then POST { challenge_id, answers } to /fdkey/submit on this same server. ..."
  }

POST /fdkey/submit
  Cookie: fdkey_session=<same-uuid>
  Authorization: Bearer eyJhbGciOiJIUzI1NiI...      // ← NEW in 0.3.0
  Content-Type: application/json

  { "challenge_id": "...", "answers": { "type1": [...], "type3": {...} } }
→ HTTP/1.1 200 OK
  Content-Type: application/json

  { "verified": true, "score": 1, "tier": "gold" }

GET /api/protected/foo  (retry with same cookie — no ticket needed here)
→ HTTP/1.1 200 OK
  ...your handler's response...
```

The `challenge_ticket` on the 402 is a short-lived HMAC-signed token
(default 5-min TTL). Agents must present it as `Authorization: Bearer
<ticket>` on `/fdkey/challenge` and `/fdkey/submit`. Without it, those
endpoints return 401 — this prevents random scripts from hammering the
challenge endpoint without ever interacting with a protected route.
The ticket is bound to the freshly-minted session id, so an agent
can't replay a ticket from one session against another.

## `reason` values

The 402 body carries a `reason` field for observability:

- `"no_session"` — request had no session id (fresh agent).
- `"unknown_session"` — session id present but unknown to the store
  (evicted by TTL/LRU, or the agent fabricated one).
- `"expired_session"` — session was verified but the policy timer
  (`every_minutes: N`) expired.

The agent's recovery is the same in every case: solve, submit, retry.
The split lets your dashboards separate "no one is authenticating" from
"sessions are being recycled too aggressively".

## Configuration reference

```ts
createFdkey({
  apiKey: 'fdk_...',              // required, must start with `fdk_`
  ticketSecret: '<32+ bytes>',     // required (0.3.0+) — HMAC secret for agent tickets
  ticketTtlSeconds: 300,           // ticket lifetime, default 300 (5 min)
  vpsUrl: 'https://api.fdkey.com',
  difficulty: 'medium',            // 'easy' | 'medium' | 'hard'
  policy: 'once_per_session',      // or { type: 'every_minutes', minutes: 15 }
  onVpsError: 'allow',             // 'allow' (default, fail-open) or 'block' (503) — see note below
  tags: { env: 'prod' },           // forwarded to FDKEY for analytics

  // Session id transport.
  sessionStrategy: 'cookie',       // 'cookie' | 'header' | { extract, attach? }
  cookieName: 'fdkey_session',     // when strategy = 'cookie'
  cookieMaxAgeSeconds: 86400,      // 24 h

  // For multi-process deployments (override with Redis-backed etc).
  sessionStore: new InMemorySessionStore(),

  // Routes the SDK mounts.
  submitPath: '/fdkey/submit',
  challengePath: '/fdkey/challenge',

  // Optional: absolute URL prefix for the integrator's public origin.
  // Required if you mount the SDK at a non-root path (e.g.
  // `app.use('/v1', fdkey.express.routes())`) — the agent needs to know
  // where to POST. Set to your origin (with the mount prefix included),
  // and `submit_url` in 402 / challenge responses becomes absolute.
  publicBaseUrl: 'https://api.example.com/v1',
});
```

## `onVpsError` — what happens when FDKEY is unreachable

**Default is `'allow'` (fail-open).** If FDKEY's scoring service is down
— we shut down, DNS hiccup, your firewall changes, whatever — your
endpoints keep serving traffic. Middleware passes the request through to
your handler with `req.fdkey === undefined`; the `/fdkey/submit` route
synthesizes a sentinel verified session so the agent stops looping. We
chose this default so an FDKEY outage doesn't brick your workflow.
FDKEY is verification, not gating — your service should still work when
ours doesn't.

If your threat model is "I'd rather drop traffic than admit unverified
callers during an outage", set `onVpsError: 'block'` instead — middleware
then returns HTTP 503.

### Behavior detail (when fail-open is active)

The SDK has **two slightly different behaviors** depending on which path
the request was on. Worth knowing if your handler code branches on the
presence vs. shape of `req.fdkey`:

| Path | Behavior on VPS error with `onVpsError: 'allow'` |
| --- | --- |
| **Middleware** (gating a route) | Calls `next()` with `req.fdkey === undefined`. Your handler sees no FDKEY context. |
| **`/fdkey/submit`** (agent's submission) | Synthesizes a sentinel session: `{ verified: true, score: 0, tier: 'allow_on_vps_error', claims: {} }`. The cookie/header is marked verified so the agent stops looping; subsequent middleware passes through with that synthetic session attached as `req.fdkey`. |

**Consistent application code:**
- ✅ `if (req.fdkey?.score >= 0.5) ...` — fails-closed in both cases (synthetic session has `score: 0`; middleware path has `req.fdkey === undefined`, which makes the comparison false).
- ✅ `if (req.fdkey?.tier === 'gold') ...` — fails-closed in both cases (synthetic session is `'allow_on_vps_error'`; undefined fails comparison).

**Inconsistent (avoid in `onVpsError: 'allow'` mode):**
- ⚠️ `if (req.fdkey) ...` — truthy on submit path (synthetic), falsy on middleware path (undefined). Use the score/tier checks above instead.

The trade-off is deliberate: synthesizing on submit prevents agents from
infinite-looping when the VPS is down (they'd otherwise see
`verified: false` forever and keep submitting), while leaving the
middleware path's `req.fdkey` undefined preserves the "we couldn't
actually verify this" signal for handlers that care.

If you want strict consistency, set `onVpsError: 'block'` — middleware
returns 503 and `/fdkey/submit` returns 503, so handlers never see a
synthetic session. The agent retries once the VPS recovers.

## Mounting at a non-root path

If you mount the SDK behind a prefix:

```ts
app.use('/v1', fdkey.express.routes());        // /v1/fdkey/submit
app.use('/v1/api/protected', fdkey.express.middleware());
```

…you **must** set `publicBaseUrl` so the 402 hint tells the agent the
right URL:

```ts
const fdkey = createFdkey({
  apiKey: '...',
  publicBaseUrl: 'https://api.example.com/v1',
});
```

Without `publicBaseUrl`, the SDK emits `submit_url: '/fdkey/submit'` —
the agent would POST to the wrong path and get a 404. Setting
`publicBaseUrl` makes it `'https://api.example.com/v1/fdkey/submit'`.

## Custom session store

```ts
import { createFdkey, type SessionStore } from '@fdkey/http';
import { createClient } from 'redis';

const redis = createClient(); await redis.connect();

const store: SessionStore = {
  async get(sid) {
    const raw = await redis.get(`fdkey:${sid}`);
    return raw ? JSON.parse(raw) : undefined;
  },
  async set(sid, session) {
    await redis.set(`fdkey:${sid}`, JSON.stringify(session), { EX: 86400 });
  },
  async delete(sid) {
    return (await redis.del(`fdkey:${sid}`)) > 0;
  },
};

const fdkey = createFdkey({ apiKey: '...', sessionStore: store });
```

## ⚠️ HTTPS only

The SDK sets cookies with `Secure; HttpOnly; SameSite=Lax`. Deploy your
server behind HTTPS — over plain HTTP, an MITM could swap the 402's
challenge body for one they've already solved. Same constraint as any
session-cookie-based auth.

## Recipe: cross-origin / cookieless agents

Some agents — headless HTTP clients, agents running in cross-origin
browser sandboxes, OpenAPI-driven Custom GPTs whose backend can't keep
a cookie jar across calls — can't or won't manage cookies. The SDK
supports a **header-based session id** for exactly this. Two ways to
turn it on:

**Header-only** (simplest if no browser users):

```ts
const fdkey = createFdkey({
  apiKey: process.env.FDKEY_API_KEY!,
  ticketSecret: process.env.FDKEY_TICKET_SECRET!,
  sessionStrategy: 'header',   // ← read X-FDKEY-Session, never set cookies
});
```

The agent reads the `X-FDKEY-Session` response header on the 402 and
echoes it on `/fdkey/submit` and the retry of the protected route.

**Hybrid — accept both cookie AND header** (recommended for sites that
serve both browser visitors and headless agents):

```ts
const fdkey = createFdkey({
  apiKey: process.env.FDKEY_API_KEY!,
  ticketSecret: process.env.FDKEY_TICKET_SECRET!,
  sessionStrategy: {
    extract: (headers) => {
      // Prefer the header (agent path); fall back to cookie (browser path).
      const get = typeof (headers as { get?: unknown }).get === 'function'
        ? (n: string) => (headers as { get: (n: string) => string | null }).get(n)
        : (n: string) => {
            const h = headers as Record<string, string | string[] | undefined>;
            const v = h[n.toLowerCase()] ?? h[n];
            return Array.isArray(v) ? v[0] ?? null : (v as string | undefined) ?? null;
          };
      const headerSid = get('x-fdkey-session');
      if (headerSid) return headerSid;
      const cookie = get('cookie');
      if (!cookie) return null;
      const m = cookie.match(/(?:^|;\s*)fdkey_session=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    },
    attach: (sid) => [
      // Browser path: standard cookie. SameSite=None+Secure so it works
      // in cross-origin contexts too (e.g. an agent in a third-party iframe).
      {
        name: 'Set-Cookie',
        value:
          `fdkey_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; ` +
          `Secure; SameSite=None; Max-Age=86400`,
      },
      // Agent path: response header. Expose it via CORS so cross-origin JS
      // can read it.
      { name: 'X-FDKEY-Session', value: sid },
    ],
  },
});
```

If you want browsers AND cross-origin browser-rendered agents to coexist,
also set up CORS to echo the request `Origin`, allow credentials, expose
`X-FDKEY-Session`, and accept `Authorization` + `X-FDKEY-Session` + `Content-Type`
as preflight-allowed headers. Hono ships a `cors` middleware that handles
this in two lines; Express has `cors`; Fastify has `@fastify/cors`.

## Recipe: publishing an OpenAPI spec for agent frameworks

If you want **ChatGPT Custom GPTs**, LangChain, LlamaIndex, Vercel AI SDK,
or any other OpenAPI-consuming agent framework to be able to drive your
verification flow as a typed function call, ship an `openapi.json` at a
stable URL on your site (e.g. `/openapi.json`). At minimum it should
describe three operations:

1. `getYourProtectedThing` (GET your protected route) — document both
   the 200 (verified) and 402 (challenge required) responses; declare
   `X-FDKEY-Session` as a response header on both.
2. `submitChallenge` (POST `/fdkey/submit`) — document `Authorization:
   Bearer <ticket>` and `X-FDKEY-Session` as required request headers,
   and the `{ challenge_id, answers }` request body.
3. `refreshChallenge` (GET `/fdkey/challenge`) — optional; same auth
   shape as submit.

The agent framework reads the spec and the agent gets typed
function-call bindings. Set authentication to **None** in the GPT
Action config — your `apiKey` stays on your server; the agent calls
your endpoints directly. See `https://fdkey.com/openapi.json` for a
worked example (the FDKEY demo site's own spec).

## Security notes

- **The agent never sees a JWT.** The SDK keeps it server-side as a
  verification artifact. The agent's session id (a cookie or header) is
  opaque to FDKEY — it's a value in your session store.
- **JWT `aud` is not validated by the SDK.** The audience claim binds
  the JWT to the integrator's `vps_users.id`, which the SDK doesn't
  know at verify time. The VPS already binds `aud` to the API key that
  requested the challenge — defense in depth — but in principle, a JWT
  issued for one FDKEY-protected service could be replayed at another
  within the JWT lifetime (~5 min default). Keep the JWT lifetime short
  on the VPS side if your threat model includes cross-integrator replay.

### Why "random scripts can't farm puzzles" — the chain of bindings

Without ticketing, an attacker could call `/fdkey/challenge` in a loop,
burning your VPS quota and possibly stockpiling solved puzzles for
later replay. **They can't.** Here's why each abuse vector dies:

| Attack | Blocked by | Outcome |
|---|---|---|
| Curl `/fdkey/challenge` directly to farm puzzles | `/fdkey/challenge` requires a Bearer ticket (since 0.3.0) | 401 `fdkey_ticket_required` |
| Forge a ticket without knowing `ticketSecret` | HMAC-SHA256 signature verification on every request | 401 `fdkey_ticket_invalid` |
| Use an expired ticket | `exp` claim check (~5min default) | 401 `fdkey_ticket_expired` |
| Steal a ticket from session A, replay against session B | Submit handler enforces `ticket.sid === cookie/header sid` | 401 `fdkey_ticket_session_mismatch` |
| Use a ticket issued by integrator A at integrator B's site | Each integrator has its own `ticketSecret` — signatures don't verify cross-integrator | 401 `fdkey_ticket_invalid` |
| Get verified at integrator A, present cookie at integrator B | B's session store doesn't recognize the sid; B's domain doesn't share cookies | Standard 402 from B |
| Get a challenge from the VPS with API key A, submit with API key B | VPS enforces `session.user_id === req.userId` at `/v1/submit` | 403 `wrong_user` from VPS |
| Steal a JWT from A's `/v1/submit` response and present at B | The agent never sees the JWT (server-to-server only) and `aud` is bound to A | N/A — agent has no JWT to steal |

The only "free" path is the integrator's own **protected route** —
which is *supposed* to be hittable without prior state because that's
where the bootstrap happens. What it returns (402 + session + ticket)
is scoped to the integrator's site, the freshly-minted session, and a
5-minute window. Hammering it just rate-limits at the integrator's
normal API layer like any other endpoint.

Verifications **don't transfer between integrators**. A user solving
the puzzle at `mybook.com` doesn't get free access at `othersite.com`
— each site has its own `apiKey`, its own `ticketSecret`, its own
session store, its own cookie domain. The design is "every site you
visit, you prove yourself once for that site," same as login cookies.

## What FDKEY DOES NOT see

- Your request bodies, query params, or response bodies.
- The end users of your API.
- Your application data.

## Low-level escape hatch

If you really want stateless JWT verification (e.g. you're embedding
FDKEY into a gRPC interceptor and don't want a session store), the SDK
exports the underlying primitives from the public entry:

```ts
import { JwtVerifier, WellKnownClient } from '@fdkey/http';

const wellKnown = new WellKnownClient('https://api.fdkey.com');
const verifier = new JwtVerifier(wellKnown);

// Anywhere you have a JWT (e.g. one another service issued through FDKEY):
const session = await verifier.verify(jwtString);
if (session) {
  // session.score, session.tier, session.claims
}
```

Use only if `createFdkey()` truly doesn't fit. The session-mediated
flow is the recommended path for any HTTP backend talking to AI agents.

## Links

- Marketing + docs: <https://fdkey.com>
- Dashboard (sign up + manage keys): <https://app.fdkey.com>
- Source: <https://github.com/fdkey/sdks>
- Issues: <https://github.com/fdkey/sdks/issues>

## License

MIT — see [LICENSE](./LICENSE).
