# @fdkey/http

> **FDKEY verification middleware for plain HTTP backends.** Gate your REST
> routes behind LLM-only puzzles. The connecting AI agent **never holds a
> token** — verified state lives in your server's session, exactly like the
> [`@fdkey/mcp`](https://www.npmjs.com/package/@fdkey/mcp) MCP middleware.
> Drop-in adapters for Express, Fastify, and Hono.

## How the flow works

```
Agent → GET /api/protected
   ↓ middleware sees no verified session
HTTP 402 with challenge embedded
   ↓ agent solves the puzzles
Agent → POST /fdkey/submit  (mounted by the SDK on YOUR server)
   ↓ SDK forwards to api.fdkey.com using your API key (server-to-server)
   ↓ SDK verifies the returned JWT offline against the well-known
   ↓ SDK marks the session verified in your session store
{ verified: true, score, tier }   ← no JWT in body, agent never sees one
   ↓
Agent → GET /api/protected   (now with verified session cookie)
   ↓ middleware looks up session → req.fdkey populated
your handler runs
```

The agent only holds a session id (a cookie or a custom header). The JWT
is a server-side verification artifact — verified once, stored as
`{ verifiedAt, score, tier, claims }`, and discarded.

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
const fdkey = createFdkey({ apiKey: process.env.FDKEY_API_KEY! });

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

const fdkey = createFdkey({ apiKey: process.env.FDKEY_API_KEY! });
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
    "hint": "Solve the puzzles, then POST { challenge_id, answers } to /fdkey/submit on this same server. ..."
  }

POST /fdkey/submit
  Cookie: fdkey_session=<same-uuid>
  Content-Type: application/json

  { "challenge_id": "...", "answers": { "type1": [...], "type3": {...} } }
→ HTTP/1.1 200 OK
  Content-Type: application/json

  { "verified": true, "score": 1, "tier": "gold" }

GET /api/protected/foo  (retry with same cookie)
→ HTTP/1.1 200 OK
  ...your handler's response...
```

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
- Source: <https://github.com/fdkey/mcp-sdks>
- Issues: <https://github.com/fdkey/mcp-sdks/issues>

## License

MIT — see [LICENSE](./LICENSE).
