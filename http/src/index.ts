/**
 * `@fdkey/http` — session-mediated FDKEY verification for HTTP backends.
 *
 *   import { createFdkey } from '@fdkey/http';
 *
 *   const fdkey = createFdkey({
 *     apiKey: process.env.FDKEY_API_KEY!,
 *     policy: 'once_per_session',
 *   });
 *
 *   // Mount the SDK's submit + challenge endpoints (the agent posts here
 *   // — never to api.fdkey.com directly).
 *   app.use(fdkey.express.routes());
 *
 *   // Gate any path you want behind verification.
 *   app.use('/api/protected', fdkey.express.middleware());
 *
 *   app.get('/api/protected/foo', (req, res) => {
 *     // req.fdkey is { sessionId, score, tier, claims, verifiedAt }.
 *     res.json({ score: req.fdkey?.score });
 *   });
 */

import type {
  ChallengeReason,
  FdkeyContext,
  FdkeyHttpConfig,
  HeadersInput,
  SessionStore,
  SubmitRequest,
  SubmitResponse,
  VerifiedSession,
} from './types.js';
import {
  DEFAULT_COOKIE_MAX_AGE_SECONDS,
  DEFAULT_COOKIE_NAME,
  buildSetCookieValue,
  mintSessionId,
  resolveSessionId,
} from './session-id.js';
import { InMemorySessionStore } from './session-store.js';
import { JwtVerifier } from './jwt-verify.js';
import { normalisePolicy, sessionStillValid, type Policy } from './policy.js';
import {
  DEFAULT_TICKET_TTL_SECONDS,
  MIN_TICKET_SECRET_BYTES,
  TicketExpiredError,
  TicketInvalidError,
  secretToBytes,
  signTicket,
  verifyTicket,
} from './ticket.js';
import { VpsClient, VpsHttpError } from './vps-client.js';
import { WellKnownClient } from './well-known.js';

export type {
  FdkeyHttpConfig,
  FdkeyContext,
  VerifiedSession,
  SessionStore,
  ChallengeBody,
  ChallengeRequiredResponse,
  ChallengeFetchResponse,
  ChallengeReason,
  SessionStrategy,
  SubmitRequest,
  SubmitResponse,
  HeadersInput,
} from './types.js';
export type { Policy, PolicyShorthand } from './policy.js';
export { InMemorySessionStore } from './session-store.js';

/** Low-level escape hatch — exported for integrators who need raw JWT
 *  verification without the session-mediated flow (e.g. embedding FDKEY
 *  into a gRPC interceptor). Use `createFdkey()` for the normal case;
 *  these are stable but support is best-effort. */
export { JwtVerifier } from './jwt-verify.js';
export { WellKnownClient } from './well-known.js';

const DEFAULT_VPS_URL = 'https://api.fdkey.com';
const DEFAULT_SUBMIT_PATH = '/fdkey/submit';
const DEFAULT_CHALLENGE_PATH = '/fdkey/challenge';

/** Bag of resolved config + per-instance state. The framework adapters
 *  (Express / Fastify / Hono) all consume this. */
interface FdkeyCore {
  config: Required<
    Pick<
      FdkeyHttpConfig,
      | 'apiKey'
      | 'cookieName'
      | 'cookieMaxAgeSeconds'
      | 'submitPath'
      | 'challengePath'
      | 'difficulty'
      | 'onVpsError'
    >
  > & {
    sessionStrategy: NonNullable<FdkeyHttpConfig['sessionStrategy']>;
    tags?: Record<string, string>;
    policy: Policy;
    /** Resolved value of `submit_url` we emit in 402 / challenge responses.
     *  Either an absolute URL (when `publicBaseUrl` is set) or a relative
     *  path (the default — works when SDK is mounted at root). */
    submitUrl: string;
    /** HMAC secret as bytes — pre-encoded once at startup so the hot
     *  path doesn't re-encode on every sign/verify. */
    ticketSecretBytes: Uint8Array;
    /** Resolved ticket lifetime (defaults to DEFAULT_TICKET_TTL_SECONDS). */
    ticketTtlSeconds: number;
  };
  sessionStore: SessionStore;
  vps: VpsClient;
  jwt: JwtVerifier;
}

/** VPS error codes that originate from the agent's submission state
 *  (challenge expired, already submitted, wrong session) and should be
 *  surfaced to the agent as a normal failed-verification response.
 *  Anything else from the VPS is treated as a service problem and
 *  returns 503 to the agent (so an integrator misconfiguration like a
 *  bad API key doesn't pretend to be the agent's fault). */
const AGENT_FACING_VPS_ERRORS = new Set<string>([
  'challenge_expired',
  'already_submitted',
  'wrong_user',
  'invalid_challenge',
]);

function isAgentFacingVpsError(err: VpsHttpError): boolean {
  if (err.status < 400 || err.status >= 500) return false;
  // 401/403 are always integrator-misconfiguration.
  if (err.status === 401 || err.status === 403) return false;
  const code = typeof err.body.error === 'string' ? err.body.error : '';
  return AGENT_FACING_VPS_ERRORS.has(code);
}

function validateConfig(config: FdkeyHttpConfig): void {
  if (
    typeof config.apiKey !== 'string' ||
    config.apiKey.length === 0
  ) {
    throw new Error(
      '@fdkey/http: `apiKey` is required. Get one at https://app.fdkey.com.',
    );
  }
  if (!config.apiKey.startsWith('fdk_')) {
    // Soft warning via thrown error: every FDKEY-issued key starts with
    // `fdk_`. If you're hitting this with a self-hosted VPS that uses a
    // different prefix, override the check by setting an env var rather
    // than passing in raw garbage.
    throw new Error(
      "@fdkey/http: `apiKey` doesn't look like an FDKEY key (expected `fdk_...`). " +
        'Pass the API key from your dashboard at https://app.fdkey.com.',
    );
  }
  if (config.publicBaseUrl !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new URL(config.publicBaseUrl);
    } catch {
      throw new Error(
        `@fdkey/http: invalid \`publicBaseUrl\`: ${config.publicBaseUrl}`,
      );
    }
  }
  if (
    typeof config.ticketSecret !== 'string' ||
    config.ticketSecret.length === 0
  ) {
    throw new Error(
      '@fdkey/http: `ticketSecret` is required. Generate one with ' +
        '`openssl rand -base64 48` and store it as a secret (env var, ' +
        'Wrangler secret, etc.) — never expose it to the agent.',
    );
  }
  if (secretToBytes(config.ticketSecret).length < MIN_TICKET_SECRET_BYTES) {
    throw new Error(
      `@fdkey/http: \`ticketSecret\` must be at least ${MIN_TICKET_SECRET_BYTES} ` +
        `bytes (HS256 minimum). Generate a fresh one with ` +
        '`openssl rand -base64 48`.',
    );
  }
  if (
    config.ticketTtlSeconds !== undefined &&
    (!Number.isFinite(config.ticketTtlSeconds) || config.ticketTtlSeconds <= 0)
  ) {
    throw new Error(
      '@fdkey/http: `ticketTtlSeconds` must be a positive number.',
    );
  }
}

function resolveSubmitUrl(config: FdkeyHttpConfig, submitPath: string): string {
  if (!config.publicBaseUrl) return submitPath;
  // Strip trailing slash from base, leading slash from path — `new URL` would
  // also work but is a bit heavyweight for a one-off concat.
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  const path = submitPath.startsWith('/') ? submitPath : '/' + submitPath;
  return base + path;
}

function buildCore(config: FdkeyHttpConfig): FdkeyCore {
  validateConfig(config);
  const vpsUrl = config.vpsUrl ?? DEFAULT_VPS_URL;
  const wellKnown = new WellKnownClient(vpsUrl);
  const submitPath = config.submitPath ?? DEFAULT_SUBMIT_PATH;
  return {
    config: {
      apiKey: config.apiKey,
      cookieName: config.cookieName ?? DEFAULT_COOKIE_NAME,
      cookieMaxAgeSeconds:
        config.cookieMaxAgeSeconds ?? DEFAULT_COOKIE_MAX_AGE_SECONDS,
      submitPath,
      challengePath: config.challengePath ?? DEFAULT_CHALLENGE_PATH,
      difficulty: config.difficulty ?? 'medium',
      onVpsError: config.onVpsError ?? 'allow',
      sessionStrategy: config.sessionStrategy ?? 'cookie',
      tags: config.tags,
      policy: normalisePolicy(config.policy),
      submitUrl: resolveSubmitUrl(config, submitPath),
      ticketSecretBytes: secretToBytes(config.ticketSecret),
      ticketTtlSeconds:
        config.ticketTtlSeconds ?? DEFAULT_TICKET_TTL_SECONDS,
    },
    sessionStore: config.sessionStore ?? new InMemorySessionStore(),
    vps: new VpsClient({
      vpsUrl,
      apiKey: config.apiKey,
      difficulty: config.difficulty ?? 'medium',
      tags: config.tags,
    }),
    jwt: new JwtVerifier(wellKnown),
  };
}

// ─── Framework-agnostic core handlers ────────────────────────────────────────
//
// These functions return abstract { status, body, setCookie? } responses.
// Each framework adapter unwraps them into framework-specific .status() /
// .json() / .header() calls.

interface AbstractResponse {
  status: number;
  body: unknown;
  /** When the SDK mints a fresh session id, the cookie strategy needs to
   *  surface it via Set-Cookie. Custom strategies surface their own
   *  headers via the strategy's `attach` callback. */
  headers?: { name: string; value: string }[];
}

interface VerifyResult {
  outcome: 'pass';
  context: FdkeyContext;
}
interface BlockResult {
  outcome: 'block';
  response: AbstractResponse;
}
type GateResult = VerifyResult | BlockResult;

/** The middleware's check: do we have a valid session for this request? */
async function gateRequest(
  core: FdkeyCore,
  headers: HeadersInput,
): Promise<GateResult> {
  const r = resolveSessionId(
    core.config.sessionStrategy,
    core.config.cookieName,
    headers,
    mintSessionId,
  );
  if (r.kind === 'missing') {
    // Header strategy with no `X-FDKEY-Session` (or custom strategy with
    // no extract+attach) — minting silently would loop forever because
    // we can't surface the sid to the agent. Loud 400 instead.
    return {
      outcome: 'block',
      response: missingSessionIdResponse(),
    };
  }
  if (r.kind === 'existing') {
    const session = await core.sessionStore.get(r.sid);
    if (session) {
      if (sessionStillValid(core.config.policy, session.verifiedAt, Date.now())) {
        return {
          outcome: 'pass',
          context: { sessionId: r.sid, ...session },
        };
      }
      return await blockWithChallenge(core, r.sid, false, 'expired_session');
    }
    return await blockWithChallenge(core, r.sid, false, 'unknown_session');
  }
  // r.kind === 'minted'
  return await blockWithChallenge(core, r.sid, true, 'no_session');
}

/** Response shape for the "header strategy missing the header" case.
 *  Distinct from a 402 — the agent's recovery is to add a header, not to
 *  solve a puzzle. */
function missingSessionIdResponse(): AbstractResponse {
  return {
    status: 400,
    body: {
      error: 'fdkey_missing_session_id',
      message:
        'This server uses header session tracking. Send a stable ' +
        '`X-FDKEY-Session: <your-id>` header on every request — your ' +
        'verified status is keyed on it. Generate any unique id (UUID ' +
        'recommended) and reuse it for the duration of your interaction.',
    },
  };
}

/** Build a 402 response for a blocked request. `mintedNew` indicates
 *  whether `sid` was just generated (we need to surface it via the chosen
 *  attach mechanism — Set-Cookie for cookie strategy). */
async function blockWithChallenge(
  core: FdkeyCore,
  sid: string,
  mintedNew: boolean,
  reason: ChallengeReason,
): Promise<BlockResult> {
  let challenge: Awaited<ReturnType<VpsClient['fetchChallenge']>>;
  try {
    challenge = await core.vps.fetchChallenge();
  } catch (err) {
    // 401/403 are integrator-config errors (bad API key) — never
    // fail-open these, even with `onVpsError: 'allow'`. The integrator
    // needs to fix their key.
    if (
      err instanceof VpsHttpError &&
      (err.status === 401 || err.status === 403)
    ) {
      return {
        outcome: 'block',
        response: {
          status: 503,
          body: {
            error: 'fdkey_service_unavailable',
            message:
              `FDKEY rejected the integrator's API key (HTTP ${err.status}). ` +
              `Check the apiKey in your createFdkey() config.`,
          },
        },
      };
    }
    if (core.config.onVpsError === 'allow') {
      // Fail-open for true outages: pass through with NO context.
      // Caller's handler should defensively check `req.fdkey` before acting.
      return {
        outcome: 'block',
        response: { status: 200, body: undefined, headers: maybeAttach(core, sid, mintedNew) },
      };
    }
    return {
      outcome: 'block',
      response: {
        status: 503,
        body: { error: 'fdkey_service_unavailable', message: String(err) },
      },
    };
  }
  const baseBody = core.vps.buildChallengeRequiredResponse(
    challenge,
    reason,
    core.config.submitUrl,
  );
  // Issue a short-lived ticket bound to `sid`. The agent presents it on
  // /fdkey/challenge and /fdkey/submit; without it, those endpoints return
  // 401. This is what prevents random scripts from hammering the challenge
  // endpoint without ever interacting with a protected route.
  const challenge_ticket = await signTicket(
    core.config.ticketSecretBytes,
    sid,
    core.config.ticketTtlSeconds,
  );
  return {
    outcome: 'block',
    response: {
      status: 402,
      body: { ...baseBody, challenge_ticket },
      headers: maybeAttach(core, sid, mintedNew),
    },
  };
}

/** Extract a Bearer token from an Authorization header (RFC 6750), or
 *  null if missing/malformed. Used by /fdkey/challenge and /fdkey/submit
 *  to read the agent's ticket. */
function extractBearerTicket(headers: HeadersInput): string | null {
  let auth: string | null = null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    auth = (headers as { get(name: string): string | null }).get('authorization');
  } else {
    const h = headers as Record<string, string | string[] | undefined>;
    const raw = h['authorization'] ?? h['Authorization'];
    if (typeof raw === 'string') auth = raw;
    else if (Array.isArray(raw) && raw.length > 0) auth = raw[0];
  }
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Check that the request carries a valid ticket. Returns the bound sid
 *  on success, or an `AbstractResponse` (401) the caller should return
 *  verbatim. Used by /fdkey/challenge and /fdkey/submit. */
async function requireValidTicket(
  core: FdkeyCore,
  headers: HeadersInput,
): Promise<{ ok: true; sid: string } | { ok: false; response: AbstractResponse }> {
  const token = extractBearerTicket(headers);
  if (!token) {
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          error: 'fdkey_ticket_required',
          message:
            'This endpoint requires a Bearer ticket. Hit a protected route ' +
            'first to receive a 402 with `challenge_ticket`, then present it ' +
            'as `Authorization: Bearer <ticket>` here.',
        },
      },
    };
  }
  try {
    const { sid } = await verifyTicket(core.config.ticketSecretBytes, token);
    return { ok: true, sid };
  } catch (err) {
    if (err instanceof TicketExpiredError) {
      return {
        ok: false,
        response: {
          status: 401,
          body: {
            error: err.code,
            message:
              'Ticket expired. Hit a protected route again to receive a fresh one.',
          },
        },
      };
    }
    if (err instanceof TicketInvalidError) {
      return {
        ok: false,
        response: {
          status: 401,
          body: {
            error: err.code,
            message:
              'Ticket invalid (bad signature or malformed). Hit a protected ' +
              'route to receive a fresh one.',
          },
        },
      };
    }
    // Unknown error during verify — surface as invalid rather than 500.
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          error: 'fdkey_ticket_invalid',
          message: 'Ticket verification failed.',
        },
      },
    };
  }
}

function maybeAttach(
  core: FdkeyCore,
  sid: string,
  mintedNew: boolean,
): { name: string; value: string }[] | undefined {
  if (!mintedNew) return undefined;
  const strategy = core.config.sessionStrategy;
  if (strategy === 'cookie') {
    return [
      {
        name: 'Set-Cookie',
        value: buildSetCookieValue(
          core.config.cookieName,
          sid,
          core.config.cookieMaxAgeSeconds,
        ),
      },
    ];
  }
  if (strategy === 'header') {
    // No place to put a freshly-minted id without breaking the
    // caller-supplies-its-own contract. Skip.
    return undefined;
  }
  return strategy.attach?.(sid);
}

/** Process an agent's POST to /fdkey/submit. Returns the abstract response
 *  to surface back. */
async function processSubmit(
  core: FdkeyCore,
  headers: HeadersInput,
  body: SubmitRequest,
): Promise<AbstractResponse> {
  // Validate body strictly. `typeof null === 'object'` and arrays are
  // also `object` — explicitly reject both. The VPS would reject these
  // too but a clean local 400 gives a faster failure for client bugs.
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.challenge_id !== 'string' ||
    body.challenge_id.length === 0 ||
    typeof body.answers !== 'object' ||
    body.answers === null ||
    Array.isArray(body.answers)
  ) {
    return {
      status: 400,
      body: { error: 'invalid_body', message: 'expected { challenge_id: string, answers: object }' },
    };
  }
  const ticketCheck = await requireValidTicket(core, headers);
  if (!ticketCheck.ok) return ticketCheck.response;
  const r = resolveSessionId(
    core.config.sessionStrategy,
    core.config.cookieName,
    headers,
    mintSessionId,
  );
  if (r.kind === 'missing') {
    // Same constraint as the middleware: we can't track this session
    // without a sid we can echo back. The submit isn't usable.
    return missingSessionIdResponse();
  }
  const sid = r.sid;
  const minted = r.kind === 'minted';
  // The ticket was issued bound to a specific sid (set when blockWithChallenge
  // minted the 402). The agent now presents the cookie/header sid alongside
  // the ticket — they MUST match, or the agent is replaying a ticket from a
  // different session.
  if (ticketCheck.sid !== sid) {
    return {
      status: 401,
      body: {
        error: 'fdkey_ticket_session_mismatch',
        message:
          'Ticket was issued for a different session than the cookie/header ' +
          'identifies. Re-trigger the protected route to receive a matching ' +
          'session + ticket pair.',
      },
    };
  }

  let vpsRes: Awaited<ReturnType<VpsClient['submitAnswers']>>;
  try {
    vpsRes = await core.vps.submitAnswers(body.challenge_id, body.answers);
  } catch (err) {
    if (err instanceof VpsHttpError && isAgentFacingVpsError(err)) {
      // Agent-facing 4xx (challenge_expired, already_submitted, etc.) —
      // surface as a normal failed-verification response so the agent
      // knows to retry with a fresh challenge.
      return {
        status: 200,
        body: {
          verified: false,
          message: err.body.error ?? 'verification_failed',
        } satisfies SubmitResponse,
        headers: maybeAttach(core, sid, minted),
      };
    }
    // 401/403 are integrator-config errors (bad API key) — NOT outages.
    // Always return 503 with a loud error so the integrator notices, even
    // with onVpsError='allow'. Fail-open is for "the service is down",
    // not "your key is wrong".
    if (
      err instanceof VpsHttpError &&
      (err.status === 401 || err.status === 403)
    ) {
      return {
        status: 503,
        body: {
          error: 'fdkey_service_unavailable',
          message:
            `FDKEY rejected the integrator's API key (HTTP ${err.status}). ` +
            `Check the apiKey in your createFdkey() config.`,
        },
      };
    }
    // Other VPS 4xx (400 invalid_body, 422 unprocessable, 404 not_found,
    // etc.) — these are CLIENT bugs: a malformed submit body or a stale
    // challenge_id reaching a route. NOT outages. Always surface them as
    // 503 with the underlying VPS error in the message, regardless of
    // `onVpsError`. Fail-open is for "the VPS is down", not "your body
    // is wrong" — per the README's contract: "If the FDKEY scoring
    // service is unreachable, the SDKs default to fail-open ... an FDKEY
    // outage shouldn't brick your workflow." A 4xx response is the VPS
    // working correctly, not an outage.
    if (
      err instanceof VpsHttpError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      return {
        status: 503,
        body: {
          error: 'fdkey_unexpected_4xx',
          message:
            `FDKEY VPS returned HTTP ${err.status} ${err.body.error ?? ''}. ` +
            `This is an integrator or SDK bug, not a VPS outage. Check the ` +
            `submit body shape against the documented wire format.`,
        },
      };
    }
    // Network errors (timeout, DNS, connection refused) and 5xx — true
    // outages. Respect onVpsError.
    if (core.config.onVpsError === 'allow') {
      // Fail-open: mark verified with `score: 0` and a sentinel tier.
      //   - `verified: true` so the agent doesn't loop on submit.
      //   - `score: 0` and `tier: 'allow_on_vps_error'` so integrator
      //     code that gates on score (`score >= 0.5`) or tier
      //     (`tier === 'gold'`) consistently fails-closed at the
      //     application layer. The middleware fail-open path passes
      //     through with `req.fdkey === undefined` for the same reason
      //     — both paths give the integrator's handler the freedom to
      //     decide how to handle "we couldn't verify but the policy
      //     said let through anyway".
      const session: VerifiedSession = {
        verifiedAt: Date.now(),
        score: 0,
        tier: 'allow_on_vps_error',
        claims: {},
      };
      await core.sessionStore.set(sid, session);
      return {
        status: 200,
        body: { verified: true, score: 0, tier: 'allow_on_vps_error' } satisfies SubmitResponse,
        headers: maybeAttach(core, sid, minted),
      };
    }
    return {
      status: 503,
      body: { error: 'fdkey_service_unavailable', message: String(err) },
    };
  }

  if (!vpsRes.verified || !vpsRes.jwt) {
    return {
      status: 200,
      body: {
        verified: false,
        message: 'Verification failed. Try a fresh challenge.',
      } satisfies SubmitResponse,
      headers: maybeAttach(core, sid, minted),
    };
  }

  // Verify the JWT offline against the well-known keys. This protects
  // against a misconfigured / malicious VPS that says verified=true but
  // signs the JWT with the wrong key.
  const session = await core.jwt.verify(vpsRes.jwt);
  if (!session) {
    return {
      status: 200,
      body: {
        verified: false,
        message: 'JWT verification failed. Try a fresh challenge.',
      } satisfies SubmitResponse,
      headers: maybeAttach(core, sid, minted),
    };
  }
  await core.sessionStore.set(sid, session);
  return {
    status: 200,
    body: {
      verified: true,
      score: session.score,
      tier: session.tier,
    } satisfies SubmitResponse,
    headers: maybeAttach(core, sid, minted),
  };
}

/** GET /fdkey/challenge — refresh the challenge for an agent that already
 *  hit a protected route (and received a 402 with `challenge_ticket`).
 *  Requires a valid Bearer ticket; without it, returns 401. This gating
 *  prevents random scripts from hammering the endpoint without ever
 *  interacting with a protected route. */
async function processChallengeFetch(
  core: FdkeyCore,
  headers: HeadersInput,
): Promise<AbstractResponse> {
  const ticketCheck = await requireValidTicket(core, headers);
  if (!ticketCheck.ok) return ticketCheck.response;
  try {
    const challenge = await core.vps.fetchChallenge();
    return {
      status: 200,
      body: core.vps.buildChallengeFetchResponse(
        challenge,
        core.config.submitUrl,
      ),
    };
  } catch (err) {
    return {
      status: 503,
      body: { error: 'fdkey_service_unavailable', message: String(err) },
    };
  }
}

// ─── Public factory ──────────────────────────────────────────────────────────

export interface FdkeyInstance {
  /** The underlying session store. Useful for `delete()` on logout etc. */
  readonly sessionStore: SessionStore;
  /** Express adapter. */
  readonly express: ExpressAdapter;
  /** Fastify adapter. */
  readonly fastify: FastifyAdapter;
  /** Hono adapter. */
  readonly hono: HonoAdapter;
}

export function createFdkey(config: FdkeyHttpConfig): FdkeyInstance {
  const core = buildCore(config);
  return {
    sessionStore: core.sessionStore,
    get express() {
      return makeExpress(core);
    },
    get fastify() {
      return makeFastify(core);
    },
    get hono() {
      return makeHono(core);
    },
  };
}

// ─── Express adapter ─────────────────────────────────────────────────────────

interface ExpressLikeReq {
  method: string;
  url?: string;
  path?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  fdkey?: FdkeyContext;
  [k: string]: unknown;
}
interface ExpressLikeRes {
  setHeader(name: string, value: string | string[]): unknown;
  status(code: number): ExpressLikeRes;
  json(body: unknown): unknown;
  end(body?: unknown): unknown;
}
type ExpressLikeNext = (err?: unknown) => void;

interface ExpressAdapter {
  /** Mounts POST /fdkey/submit (and POST /fdkey/challenge). Use as
   *  `app.use(fdkey.express.routes())`. */
  routes(): (req: ExpressLikeReq, res: ExpressLikeRes, next: ExpressLikeNext) => Promise<void>;
  /** Gates a route. Use as `app.use('/api', fdkey.express.middleware())`. */
  middleware(): (req: ExpressLikeReq, res: ExpressLikeRes, next: ExpressLikeNext) => Promise<void>;
}

function applyHeaders(res: ExpressLikeRes, headers?: { name: string; value: string }[]): void {
  if (!headers) return;
  for (const h of headers) res.setHeader(h.name, h.value);
}

function pathOf(req: ExpressLikeReq): string {
  if (req.path) return req.path;
  // url is /foo?bar=baz — strip the query string.
  const u = req.url ?? req.originalUrl ?? '';
  const q = u.indexOf('?');
  return q >= 0 ? u.slice(0, q) : u;
}

function makeExpress(core: FdkeyCore): ExpressAdapter {
  // Express 4 doesn't auto-propagate async errors to its error middleware
  // — if an async handler throws, the request hangs unless we explicitly
  // call `next(err)`. Express 5 fixes this; many integrators are still
  // on 4. The wrapper handles both.
  return {
    routes() {
      return async function fdkeyRoutes(req, res, next) {
        try {
          const p = pathOf(req);
          if (req.method === 'POST' && p === core.config.submitPath) {
            const out = await processSubmit(core, req.headers, req.body as SubmitRequest);
            applyHeaders(res, out.headers);
            res.status(out.status).json(out.body);
            return;
          }
          if (
            (req.method === 'GET' || req.method === 'POST') &&
            p === core.config.challengePath
          ) {
            const out = await processChallengeFetch(core, req.headers);
            applyHeaders(res, out.headers);
            res.status(out.status).json(out.body);
            return;
          }
          next();
        } catch (err) {
          next(err);
        }
      };
    },
    middleware() {
      return async function fdkeyMiddleware(req, res, next) {
        try {
          const result = await gateRequest(core, req.headers);
          if (result.outcome === 'pass') {
            req.fdkey = result.context;
            return next();
          }
          applyHeaders(res, result.response.headers);
          if (result.response.body === undefined) {
            // Fail-open path.
            return next();
          }
          res.status(result.response.status).json(result.response.body);
        } catch (err) {
          next(err);
        }
      };
    },
  };
}

// ─── Fastify adapter ─────────────────────────────────────────────────────────

interface FastifyLikeReq {
  method: string;
  url: string;
  routerPath?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  fdkey?: FdkeyContext;
}
interface FastifyLikeReply {
  header(name: string, value: string): FastifyLikeReply;
  status(code: number): FastifyLikeReply;
  send(payload: unknown): unknown;
}
interface FastifyLikeApp {
  post(path: string, handler: (req: FastifyLikeReq, reply: FastifyLikeReply) => Promise<unknown>): unknown;
  get(path: string, handler: (req: FastifyLikeReq, reply: FastifyLikeReply) => Promise<unknown>): unknown;
  addHook(name: string, handler: (req: FastifyLikeReq, reply: FastifyLikeReply) => Promise<void>): unknown;
}

interface FastifyAdapter {
  /** Register the SDK's POST /fdkey/submit + GET /fdkey/challenge routes
   *  on a Fastify instance. */
  registerRoutes(app: FastifyLikeApp): void;
  /** Add a global preHandler hook that gates every incoming request.
   *  Combine with Fastify's per-route hook config to scope it. */
  preHandler(): (req: FastifyLikeReq, reply: FastifyLikeReply) => Promise<void>;
}

function applyFastifyHeaders(reply: FastifyLikeReply, headers?: { name: string; value: string }[]): void {
  if (!headers) return;
  for (const h of headers) reply.header(h.name, h.value);
}

function makeFastify(core: FdkeyCore): FastifyAdapter {
  return {
    registerRoutes(app) {
      app.post(core.config.submitPath, async (req, reply) => {
        const out = await processSubmit(core, req.headers, req.body as SubmitRequest);
        applyFastifyHeaders(reply, out.headers);
        return reply.status(out.status).send(out.body);
      });
      app.get(core.config.challengePath, async (req, reply) => {
        const out = await processChallengeFetch(core, req.headers);
        applyFastifyHeaders(reply, out.headers);
        return reply.status(out.status).send(out.body);
      });
    },
    preHandler() {
      return async function fdkeyPreHandler(req, reply) {
        const result = await gateRequest(core, req.headers);
        if (result.outcome === 'pass') {
          req.fdkey = result.context;
          return;
        }
        applyFastifyHeaders(reply, result.response.headers);
        if (result.response.body === undefined) return; // fail-open
        await reply.status(result.response.status).send(result.response.body);
      };
    },
  };
}

// ─── Hono adapter ────────────────────────────────────────────────────────────

interface HonoLikeRequest {
  method: string;
  path?: string;
  url?: string;
  header(name: string): string | undefined;
  json(): Promise<unknown>;
}
interface HonoLikeContext {
  req: HonoLikeRequest;
  set(key: string, value: unknown): void;
  json(body: unknown, status?: number): Response;
  header(name: string, value: string): void;
}
type HonoNext = () => Promise<void>;

/** Hono `Headers`-style wrapper around its context.req.header(). */
function honoHeadersAdapter(c: HonoLikeContext): HeadersInput {
  return {
    get(name: string): string | null {
      return c.req.header(name) ?? null;
    },
  };
}

interface HonoAdapter {
  /** Register the SDK's submit + challenge routes on a Hono app. */
  registerRoutes(app: {
    post(path: string, h: (c: HonoLikeContext) => Promise<Response>): unknown;
    get(path: string, h: (c: HonoLikeContext) => Promise<Response>): unknown;
  }): void;
  /** Hono middleware. Use as `app.use('/api/*', fdkey.hono.middleware())`. */
  middleware(): (c: HonoLikeContext, next: HonoNext) => Promise<Response | void>;
}

function applyHonoHeaders(c: HonoLikeContext, headers?: { name: string; value: string }[]): void {
  if (!headers) return;
  for (const h of headers) c.header(h.name, h.value);
}

function makeHono(core: FdkeyCore): HonoAdapter {
  return {
    registerRoutes(app) {
      app.post(core.config.submitPath, async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as SubmitRequest;
        const out = await processSubmit(core, honoHeadersAdapter(c), body);
        applyHonoHeaders(c, out.headers);
        return c.json(out.body as object, out.status);
      });
      app.get(core.config.challengePath, async (c) => {
        const out = await processChallengeFetch(core, honoHeadersAdapter(c));
        applyHonoHeaders(c, out.headers);
        return c.json(out.body as object, out.status);
      });
    },
    middleware() {
      return async function fdkeyHonoMiddleware(c, next) {
        const result = await gateRequest(core, honoHeadersAdapter(c));
        if (result.outcome === 'pass') {
          c.set('fdkey', result.context);
          return next();
        }
        applyHonoHeaders(c, result.response.headers);
        if (result.response.body === undefined) return next();
        return c.json(result.response.body as object, result.response.status);
      };
    },
  };
}
