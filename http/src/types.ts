/**
 * Public types for `@fdkey/http`.
 *
 * Session-mediated flow (the agent never holds a JWT):
 *
 *   Agent → /api/protected (no/unverified session)
 *     ↓ middleware
 *   402 with challenge embedded
 *     ↓
 *   Agent → POST /fdkey/submit (with answers)
 *     ↓ SDK forwards to api.fdkey.com server-to-server
 *   { verified: true, score, tier }   ← no JWT in body
 *     ↓ session marked verified server-side
 *   Agent → /api/protected (verified session)
 *     ↓ middleware
 *   handler runs, req.fdkey populated
 */

import type { Policy, PolicyShorthand } from './policy.js';

/** Configuration for `createFdkey()`. */
export interface FdkeyHttpConfig {
  /** Integrator's VPS API key. **NEVER sent to the agent** — used only for
   *  server-to-server calls to `api.fdkey.com`. */
  apiKey: string;

  /** HMAC secret used to sign short-lived agent tickets (the
   *  `challenge_ticket` field on the 402 response). Required: must be a
   *  string of at least 32 bytes (256 bits). Generate one with
   *  `openssl rand -base64 48` and store it as a secret (env var, KV,
   *  Wrangler secret, etc.) — alongside `apiKey`, never exposed to the
   *  agent. Used internally to sign/verify the tickets that gate
   *  `/fdkey/challenge` and `/fdkey/submit`. */
  ticketSecret: string;

  /** Ticket lifetime in seconds. Default: 300 (5 minutes). Long enough
   *  for a slow agent to fetch a challenge, solve it, retry on a fresh
   *  one, and submit. Short enough that a leaked ticket isn't a
   *  long-lived authorization. */
  ticketTtlSeconds?: number;

  /** VPS base URL. Default: `https://api.fdkey.com`. Override for self-hosted. */
  vpsUrl?: string;

  /** `easy` | `medium` | `hard` — forwarded to the VPS. Default: `medium`. */
  difficulty?: 'easy' | 'medium' | 'hard';

  /** Re-verification policy. Once an agent has solved a challenge, how long
   *  does that verification last?
   *
   *  - `'once_per_session'` (default): pass forever once verified — until the
   *    session is evicted or the agent reconnects.
   *  - `{ type: 'every_minutes', minutes: N }`: pass while
   *    `now - verifiedAt < N minutes`. The clock does NOT extend on calls;
   *    it expires N minutes after the puzzle was solved.
   *
   *  `each_call` is intentionally NOT supported here — for HTTP it would
   *  mean every API call requires a fresh puzzle solve, which makes the
   *  API unusable. If you want stricter guarantees, lower the JWT lifetime
   *  on the VPS side or use `every_minutes: 1`. */
  policy?: Policy | PolicyShorthand;

  /** What happens when the FDKEY VPS is unreachable. Default: `'allow'`
   *  (fail-open) — middleware passes the request through to your handler
   *  with no `req.fdkey` context, and `/fdkey/submit` synthesizes a
   *  sentinel verified session. An FDKEY service outage doesn't brick
   *  your endpoints. Set to `'block'` (returns HTTP 503) if your threat
   *  model prefers fail-closed. */
  onVpsError?: 'block' | 'allow';

  /** Free-form non-PII labels forwarded to the VPS for analytics. */
  tags?: Record<string, string>;

  /** How to identify a session across requests. Default: `'cookie'` —
   *  the SDK reads/sets `fdkey_session=<uuid>` on every response.
   *
   *  - `'cookie'`: read/write `fdkey_session` cookie.
   *  - `'header'`: read `X-FDKEY-Session: <id>` from request headers
   *    (caller-supplied id; SDK does not mint one).
   *  - `{ extract, attach? }`: caller-defined extraction. `attach` is
   *    optional — used when the SDK mints a new id and needs to surface
   *    it to the response (cookie strategy uses Set-Cookie; for custom
   *    strategies, decide where to put it). */
  sessionStrategy?: SessionStrategy;

  /** Cookie name when `sessionStrategy: 'cookie'`. Default: `fdkey_session`. */
  cookieName?: string;

  /** Cookie max-age in seconds. Default: 86400 (24h). */
  cookieMaxAgeSeconds?: number;

  /** Override the session store. Default: bounded in-memory (10k LRU + 1h TTL).
   *  For multi-process deployments, supply a Redis-backed store. */
  sessionStore?: SessionStore;

  /** Path the SDK mounts for the agent's submit endpoint. Default: `/fdkey/submit`. */
  submitPath?: string;

  /** Path the SDK mounts for fetching a challenge directly (used by integrator
   *  UIs that render a "register as AI agent" page). Default: `/fdkey/challenge`. */
  challengePath?: string;

  /** Optional absolute URL prefix for the integrator's public origin —
   *  used to build the `submit_url` field of the 402 response so the agent
   *  knows where to POST. Two scenarios:
   *
   *    1. SDK is mounted at a non-root path (e.g.
   *       `app.use('/v1', fdkey.express.routes())`). The agent must POST
   *       to `/v1/fdkey/submit`, NOT `/fdkey/submit`. Set
   *       `publicBaseUrl: 'https://api.example.com/v1'`.
   *    2. You want absolute URLs in 402 responses regardless of mount —
   *       useful for cross-origin agent calls. Set
   *       `publicBaseUrl: 'https://api.example.com'`.
   *
   *  When unset, `submit_url` falls back to `submitPath` (a relative path).
   *  This works fine when the SDK is mounted at root and the agent is
   *  same-origin. */
  publicBaseUrl?: string;
}

/** Session-id extraction strategy. */
export type SessionStrategy =
  | 'cookie'
  | 'header'
  | {
      /** Pull a session id off an incoming request, or null if none. */
      extract: (headers: HeadersInput) => string | null;
      /** Optional: SDK calls this with a freshly-minted id when the agent
       *  is unverified and we want subsequent requests to find the session.
       *  Cookie strategy uses Set-Cookie; for custom strategies, place the
       *  id wherever your auth flow expects it. Returns headers to merge
       *  into the response. */
      attach?: (sid: string) => { name: string; value: string }[];
    };

/** Headers either as a plain Record (Express/Fastify-style) or a Web Headers
 *  object (Hono / global Request). The SDK accepts either. */
export type HeadersInput =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

/** What the SDK stores per verified session. */
export interface VerifiedSession {
  /** When the agent successfully verified (ms epoch). */
  verifiedAt: number;
  /** Capability score from the JWT, in [0, 1]. Today binary; reserved for
   *  graduated capability scoring later. */
  score: number;
  /** VPS-issued tier label. */
  tier: string;
  /** Raw decoded JWT claims for power users. */
  claims: Record<string, unknown>;
}

/** Async session store. Default impl is in-memory bounded; integrators in
 *  multi-process deployments override with Redis-backed etc. */
export interface SessionStore {
  get(sid: string): Promise<VerifiedSession | undefined>;
  set(sid: string, session: VerifiedSession): Promise<void>;
  delete(sid: string): Promise<boolean>;
}

/** What gets attached to `req.fdkey` / `c.var.fdkey` when a session is
 *  verified. Same shape as `VerifiedSession` plus `sessionId`. */
export interface FdkeyContext extends VerifiedSession {
  sessionId: string;
}

/** Why the middleware emitted a 402. The agent's recovery action is the same
 *  in every case (solve and submit), but observability dashboards can split
 *  these to see the user behavior. */
export type ChallengeReason =
  /** No session id and no header — fresh agent. */
  | 'no_session'
  /** Session id present but unknown (evicted or never existed). */
  | 'unknown_session'
  /** Session was verified but the policy timer expired. */
  | 'expired_session';

/** Common fields between the 402 challenge response (middleware) and the
 *  explicit GET /fdkey/challenge response (UI fetch). */
export interface ChallengeBody {
  challenge_id: string;
  expires_at: string;
  expires_in_seconds: number;
  difficulty: string;
  types_served: string[];
  puzzles: Record<string, unknown>;
  /** Where the agent should POST its answers — the integrator's own
   *  `/fdkey/submit` route, NOT api.fdkey.com. Absolute when
   *  `FdkeyHttpConfig.publicBaseUrl` is set; relative path otherwise. */
  submit_url: string;
  hint: string;
}

/** Shape of the HTTP 402 body. The agent should POST { challenge_id, answers }
 *  to the SDK's `/fdkey/submit` route — NOT to api.fdkey.com directly (the
 *  agent has no API key, the VPS would reject). */
export interface ChallengeRequiredResponse extends ChallengeBody {
  error: 'fdkey_verification_required';
  reason: ChallengeReason;
  /** Short-lived HMAC-signed authorization the agent presents on
   *  `/fdkey/challenge` and `/fdkey/submit` as `Authorization: Bearer <ticket>`.
   *  Bound to the freshly-minted session id and the configured
   *  `ticketTtlSeconds` (default 300s / 5 min). Without it, those endpoints
   *  return 401 — preventing random scripts from hammering the challenge
   *  endpoint without ever interacting with the protected route. */
  challenge_ticket: string;
}

/** Shape of the GET /fdkey/challenge response. Same wire fields as the 402
 *  body minus the `error` and `reason` markers — those are 402-specific.
 *  Integrator-rendered UIs that render the puzzles inline parse this. */
export type ChallengeFetchResponse = ChallengeBody;

/** Body shape POSTed by the agent to `/fdkey/submit`. */
export interface SubmitRequest {
  challenge_id: string;
  answers: Record<string, unknown>;
}

/** What the SDK returns from `/fdkey/submit`. The agent never sees a JWT —
 *  the SDK keeps it server-side as a verification artifact. */
export interface SubmitResponse {
  verified: boolean;
  /** Capability score, only present when verified=true. */
  score?: number;
  /** Tier label, only present when verified=true. */
  tier?: string;
  message?: string;
}
