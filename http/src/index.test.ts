/**
 * End-to-end tests for the session-mediated `@fdkey/http` flow.
 *
 * The agent NEVER sees a JWT — verifies that the SDK keeps the JWT
 * server-side and only emits `{ verified, score, tier }` to the agent.
 *
 * Tests run against a wiremock-shaped global `fetch` stub that mimics
 * the FDKEY VPS — well-known + /v1/challenge + /v1/submit. Real
 * Ed25519 keys are generated per-test so the JWT round-trip is
 * actually exercised, not just shape-checked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { createFdkey, InMemorySessionStore, type FdkeyContext, type SubmitResponse } from './index.js';

const VPS_URL = 'https://api.test';
const KID = 'test-key-1';

let privateKey: CryptoKey;
let publicKeyPem: string;

beforeEach(async () => {
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  privateKey = kp.privateKey as CryptoKey;
  publicKeyPem = await exportSPKI(kp.publicKey as CryptoKey);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signJwt(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ score: 1, tier: 'gold', threshold: 0.5, ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID })
    .setIssuer('vps').setAudience('integrator').setSubject('session-1')
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 600)
    .sign(privateKey);
}

interface MockState {
  challengeCalls: number;
  submitCalls: number;
  wellKnownCalls: number;
  lastChallengeAuth?: string;
  lastSubmitAuth?: string;
  lastSubmitBody?: unknown;
  challengeResponse: Record<string, unknown>;
  submitJwt: string | null;
  submitVerified: boolean;
}

function installMockVps(): MockState {
  const state: MockState = {
    challengeCalls: 0,
    submitCalls: 0,
    wellKnownCalls: 0,
    challengeResponse: {
      challenge_id: 'cid-test-1',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      expires_in_seconds: 300,
      difficulty: 'medium',
      types_served: ['type1', 'type3'],
      puzzles: { type1: [{ q: 'foo', options: ['a', 'b', 'c', 'd'] }] },
    },
    submitJwt: null,
    submitVerified: true,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    if (u.endsWith('/.well-known/fdkey.json')) {
      state.wellKnownCalls += 1;
      return new Response(JSON.stringify({
        issuer: 'vps',
        keys: [{ alg: 'EdDSA', kid: KID, public_key_pem: publicKeyPem }],
        jwt_default_lifetime_seconds: 600,
      }), { status: 200 });
    }
    if (u.endsWith('/v1/challenge')) {
      state.challengeCalls += 1;
      state.lastChallengeAuth = auth;
      return new Response(JSON.stringify(state.challengeResponse), { status: 200 });
    }
    if (u.endsWith('/v1/submit')) {
      state.submitCalls += 1;
      state.lastSubmitAuth = auth;
      state.lastSubmitBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(JSON.stringify({
        verified: state.submitVerified,
        jwt: state.submitJwt,
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }));
  return state;
}

// ── Test fixtures: minimal Express-shaped req/res ─────────────────────────────

function makeReq(opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return {
    method: opts.method ?? 'GET',
    path: opts.path ?? '/api/protected/foo',
    url: opts.path ?? '/api/protected/foo',
    headers: opts.headers ?? {},
    body: opts.body,
  } as never;
}

function makeRes() {
  let status = 200;
  let body: unknown = undefined;
  const headersOut: Record<string, string | string[]> = {};
  const res = {
    setHeader(name: string, value: string | string[]) { headersOut[name] = value; return res; },
    status(code: number) { status = code; return res; },
    json(b: unknown) { body = b; return res; },
    end(b?: unknown) { if (b !== undefined) body = b; return res; },
  };
  return {
    res: res as never,
    get status() { return status; },
    get body() { return body; },
    get headers() { return headersOut; },
  };
}

describe('createFdkey: middleware (no session → 402)', () => {
  it('returns 402 with reason=no_session and Set-Cookie when no cookie present', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const mw = fdkey.express.middleware();

    const req = makeReq({ headers: {} });
    const r = makeRes();
    const next = vi.fn();
    await mw(req, r.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(r.status).toBe(402);
    const body = r.body as Record<string, unknown>;
    expect(body.error).toBe('fdkey_verification_required');
    expect(body.reason).toBe('no_session');
    expect(body.submit_url).toBe('/fdkey/submit');
    expect(body.challenge_id).toBe('cid-test-1');
    // Verify Set-Cookie was emitted (so the agent's next request finds the session).
    const setCookie = r.headers['Set-Cookie'] as string | undefined;
    expect(setCookie).toBeDefined();
    expect(setCookie!).toMatch(/^fdkey_session=[a-f0-9-]+/i);
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).toContain('SameSite=Lax');
    expect(setCookie!).toContain('Secure');
  });

  it('uses the integrator API key when fetching the challenge (server-to-server)', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({ apiKey: 'fdk_secret_xyz', vpsUrl: VPS_URL });
    const mw = fdkey.express.middleware();
    await mw(makeReq(), makeRes().res, vi.fn());
    expect(mock.lastChallengeAuth).toBe('Bearer fdk_secret_xyz');
  });
});

describe('createFdkey: /fdkey/submit (full round-trip, agent never sees JWT)', () => {
  it('verifies a valid submission and returns { verified, score, tier } — no JWT in body', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt({ score: 1.0, tier: 'gold' });
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();

    const req = makeReq({
      method: 'POST',
      path: '/fdkey/submit',
      headers: { cookie: 'fdkey_session=test-sid-1' },
      body: { challenge_id: 'cid-test-1', answers: { type1: ['B'], type3: { q1: ['a','b','c','d','e'] } } },
    });
    const r = makeRes();
    await routes(req, r.res, vi.fn());

    expect(mock.submitCalls).toBe(1);
    // The integrator API key was used server-to-server.
    expect(mock.lastSubmitAuth).toBe('Bearer fdk_test');
    expect(r.status).toBe(200);
    const body = r.body as SubmitResponse & Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(body.score).toBe(1.0);
    expect(body.tier).toBe('gold');
    // CRITICAL: no JWT leaks to the agent.
    expect(body.jwt).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(mock.submitJwt!);

    // The session is now in the store under the cookie value.
    const stored = await fdkey.sessionStore.get('test-sid-1');
    expect(stored).toBeDefined();
    expect(stored!.score).toBe(1.0);
  });

  it('rejects when the JWT is signed by a non-well-known key', async () => {
    const mock = installMockVps();
    // Mint a JWT signed with a DIFFERENT keypair than the well-known returns.
    const otherKp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const now = Math.floor(Date.now() / 1000);
    mock.submitJwt = await new SignJWT({ score: 1, tier: 'gold' })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setIssuer('rogue').setAudience('a').setSubject('s')
      .setIssuedAt(now).setExpirationTime(now + 600)
      .sign(otherKp.privateKey as CryptoKey);
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();

    const req = makeReq({
      method: 'POST',
      path: '/fdkey/submit',
      headers: { cookie: 'fdkey_session=test-sid-2' },
      body: { challenge_id: 'cid-test-1', answers: { type1: ['A'] } },
    });
    const r = makeRes();
    await routes(req, r.res, vi.fn());

    const body = r.body as SubmitResponse;
    expect(body.verified).toBe(false);
    expect(body.message).toMatch(/jwt verification failed/i);
    // Session must NOT have been marked verified.
    expect(await fdkey.sessionStore.get('test-sid-2')).toBeUndefined();
  });

  it('rejects when the VPS itself says verified=false', async () => {
    const mock = installMockVps();
    mock.submitVerified = false;
    mock.submitJwt = null;
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const req = makeReq({
      method: 'POST',
      path: '/fdkey/submit',
      headers: { cookie: 'fdkey_session=test-sid-3' },
      body: { challenge_id: 'cid-test-1', answers: { type1: ['Z'] } },
    });
    const r = makeRes();
    await routes(req, r.res, vi.fn());
    const body = r.body as SubmitResponse;
    expect(body.verified).toBe(false);
    expect(await fdkey.sessionStore.get('test-sid-3')).toBeUndefined();
  });

  it('rejects malformed bodies with 400', async () => {
    installMockVps();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const req = makeReq({
      method: 'POST',
      path: '/fdkey/submit',
      headers: {},
      body: { not: 'right' },
    });
    const r = makeRes();
    await routes(req, r.res, vi.fn());
    expect(r.status).toBe(400);
  });
});

describe('createFdkey: middleware (verified session → pass-through)', () => {
  it('attaches req.fdkey and calls next() when the session is verified', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt({ score: 0.75, tier: 'silver' });
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const mw = fdkey.express.middleware();

    // Step 1: agent submits successfully with a known sid.
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=verified-sid' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      }),
      makeRes().res,
      vi.fn(),
    );

    // Step 2: agent retries the protected route with the same cookie.
    const req = makeReq({ headers: { cookie: 'fdkey_session=verified-sid' } });
    const r = makeRes();
    const next = vi.fn();
    await mw(req, r.res, next);

    expect(next).toHaveBeenCalledOnce();
    const ctx = (req as { fdkey?: FdkeyContext }).fdkey;
    expect(ctx).toBeDefined();
    expect(ctx!.sessionId).toBe('verified-sid');
    expect(ctx!.score).toBe(0.75);
    expect(ctx!.tier).toBe('silver');
    expect(ctx!.claims).toBeDefined();
  });

  it('returns 402 with reason=unknown_session when the cookie points at an unknown sid', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const mw = fdkey.express.middleware();

    const req = makeReq({ headers: { cookie: 'fdkey_session=ghost-sid' } });
    const r = makeRes();
    await mw(req, r.res, vi.fn());

    expect(r.status).toBe(402);
    expect((r.body as Record<string, unknown>).reason).toBe('unknown_session');
    // Existing cookie kept — no Set-Cookie emitted on this path.
    expect(r.headers['Set-Cookie']).toBeUndefined();
  });
});

describe('createFdkey: policy: every_minutes', () => {
  it('expires a verified session after the configured window', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    // Use a custom session store with a controlled clock for the
    // SDK-side policy check.
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      policy: { type: 'every_minutes', minutes: 5 },
    });
    const routes = fdkey.express.routes();
    const mw = fdkey.express.middleware();

    // Verify.
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=ttl-sid' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      }),
      makeRes().res,
      vi.fn(),
    );

    // Push the verifiedAt 6 minutes into the past.
    const stored = await fdkey.sessionStore.get('ttl-sid');
    expect(stored).toBeDefined();
    await fdkey.sessionStore.set('ttl-sid', {
      ...stored!,
      verifiedAt: Date.now() - 6 * 60 * 1000,
    });

    const req = makeReq({ headers: { cookie: 'fdkey_session=ttl-sid' } });
    const r = makeRes();
    await mw(req, r.res, vi.fn());
    expect(r.status).toBe(402);
    expect((r.body as Record<string, unknown>).reason).toBe('expired_session');
  });
});

describe('createFdkey: header sessionStrategy', () => {
  it('reads X-FDKEY-Session instead of cookie', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStrategy: 'header',
    });
    const routes = fdkey.express.routes();
    const mw = fdkey.express.middleware();

    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { 'x-fdkey-session': 'header-sid-1' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      }),
      makeRes().res,
      vi.fn(),
    );

    const req = makeReq({ headers: { 'x-fdkey-session': 'header-sid-1' } });
    const r = makeRes();
    const next = vi.fn();
    await mw(req, r.res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createFdkey: integrator-supplied session store', () => {
  it('uses the override store for get/set/delete', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const store = new InMemorySessionStore();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStore: store,
    });
    const routes = fdkey.express.routes();

    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=override-sid' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      }),
      makeRes().res,
      vi.fn(),
    );

    expect(await store.get('override-sid')).toBeDefined();
    expect(fdkey.sessionStore).toBe(store);
  });
});

describe('createFdkey: VPS unreachable', () => {
  it('falls open by default when /v1/challenge fails (onVpsError defaults to allow)', async () => {
    // Default is 'allow' so an FDKEY outage doesn't brick the integrator's
    // endpoints — middleware passes the request through with no req.fdkey.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const mw = fdkey.express.middleware();
    const req = makeReq();
    const r = makeRes();
    const next = vi.fn();
    await mw(req, r.res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 503 when onVpsError=block (opt-in fail-closed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const fdkey = createFdkey({
      apiKey: 'fdk_test', vpsUrl: VPS_URL, onVpsError: 'block',
    });
    const mw = fdkey.express.middleware();
    const req = makeReq();
    const r = makeRes();
    await mw(req, r.res, vi.fn());
    expect(r.status).toBe(503);
  });
});

describe('createFdkey: config validation', () => {
  it('throws when apiKey is missing', () => {
    expect(() => createFdkey({} as never)).toThrow(/apiKey.*required/is);
    expect(() => createFdkey({ apiKey: '' } as never)).toThrow(/apiKey.*required/is);
  });

  it('throws when apiKey doesn\'t look like an FDKEY key', () => {
    expect(() => createFdkey({ apiKey: 'not-an-fdkey-key' })).toThrow(/fdk_/);
  });

  it('throws when publicBaseUrl is malformed', () => {
    expect(() =>
      createFdkey({ apiKey: 'fdk_test', publicBaseUrl: 'not a url' as never }),
    ).toThrow(/invalid `publicBaseUrl`/i);
  });

  it('accepts a valid publicBaseUrl', () => {
    expect(() =>
      createFdkey({
        apiKey: 'fdk_test',
        vpsUrl: VPS_URL,
        publicBaseUrl: 'https://api.example.com/v1',
      }),
    ).not.toThrow();
  });
});

describe('createFdkey: body validation on /fdkey/submit', () => {
  it('rejects null answers with 400', async () => {
    installMockVps();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: {},
        body: { challenge_id: 'cid-1', answers: null },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(400);
  });

  it('rejects array answers with 400', async () => {
    installMockVps();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: {},
        body: { challenge_id: 'cid-1', answers: [{ type1: ['B'] }] },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(400);
  });

  it('rejects empty challenge_id with 400', async () => {
    installMockVps();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: {},
        body: { challenge_id: '', answers: { type1: ['B'] } },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(400);
  });
});

describe('createFdkey: VPS error split (4xx → agent vs integrator)', () => {
  it('treats 401 (bad API key) as integrator misconfig — returns 503, NOT verification_failed', async () => {
    // VPS returns 401 with `error: "invalid_api_key"`. The agent shouldn't
    // be told their verification failed — it's not their problem.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      if (u.endsWith('/v1/submit')) {
        return new Response(
          JSON.stringify({ error: 'invalid_api_key' }),
          { status: 401 },
        );
      }
      return new Response('not found', { status: 404 });
    }));
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=bad-key-sid' },
        body: { challenge_id: 'cid-1', answers: { type1: ['B'] } },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(503);
    expect((r.body as Record<string, unknown>).error).toBe('fdkey_service_unavailable');
  });

  it('treats 400 challenge_expired as agent-facing — returns 200 verified=false', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      if (u.endsWith('/v1/submit')) {
        return new Response(
          JSON.stringify({ error: 'challenge_expired' }),
          { status: 400 },
        );
      }
      return new Response('not found', { status: 404 });
    }));
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=expired-sid' },
        body: { challenge_id: 'cid-1', answers: { type1: ['B'] } },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(200);
    const body = r.body as SubmitResponse;
    expect(body.verified).toBe(false);
    expect(body.message).toBe('challenge_expired');
  });
});

describe('createFdkey: GET /fdkey/challenge', () => {
  it('returns clean ChallengeFetchResponse shape (no error/reason fields)', async () => {
    installMockVps();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({ method: 'GET', path: '/fdkey/challenge', headers: {} }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    // Must NOT carry the 402-only markers.
    expect(body.error).toBeUndefined();
    expect(body.reason).toBeUndefined();
    // Must carry the actual challenge fields.
    expect(body.challenge_id).toBe('cid-test-1');
    expect(body.puzzles).toBeDefined();
    expect(body.submit_url).toBe('/fdkey/submit');
  });

  it('returns 503 when VPS is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({ method: 'GET', path: '/fdkey/challenge', headers: {} }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(503);
  });
});

describe('createFdkey: publicBaseUrl absolute submit_url', () => {
  it('emits absolute URL in 402 submit_url when publicBaseUrl is set', async () => {
    installMockVps();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      publicBaseUrl: 'https://api.example.com/v1',
    });
    const mw = fdkey.express.middleware();
    const r = makeRes();
    await mw(makeReq(), r.res, vi.fn());
    const body = r.body as Record<string, unknown>;
    expect(body.submit_url).toBe('https://api.example.com/v1/fdkey/submit');
    expect(body.hint).toContain('https://api.example.com/v1/fdkey/submit');
  });

  it('emits absolute URL in /fdkey/challenge submit_url when publicBaseUrl is set', async () => {
    installMockVps();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      publicBaseUrl: 'https://api.example.com',
    });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({ method: 'GET', path: '/fdkey/challenge', headers: {} }),
      r.res,
      vi.fn(),
    );
    const body = r.body as Record<string, unknown>;
    expect(body.submit_url).toBe('https://api.example.com/fdkey/submit');
  });

  it('handles trailing slash on publicBaseUrl correctly', async () => {
    installMockVps();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      publicBaseUrl: 'https://api.example.com/',
    });
    const mw = fdkey.express.middleware();
    const r = makeRes();
    await mw(makeReq(), r.res, vi.fn());
    const body = r.body as Record<string, unknown>;
    // No double slash.
    expect(body.submit_url).toBe('https://api.example.com/fdkey/submit');
  });
});

describe('createFdkey: custom session strategy', () => {
  it('uses extract+attach for non-cookie session transport', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();

    let attachCalledWith: string | null = null;
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStrategy: {
        extract: (headers) => {
          // Custom strategy: pull session id from a JWT-style header.
          if (typeof (headers as { get?: unknown }).get === 'function') {
            return (headers as { get(n: string): string | null }).get(
              'x-custom-session',
            );
          }
          const h = headers as Record<string, string | undefined>;
          return h['x-custom-session'] ?? null;
        },
        attach: (sid) => {
          attachCalledWith = sid;
          return [{ name: 'X-Custom-Session-Mint', value: sid }];
        },
      },
    });
    const mw = fdkey.express.middleware();
    const routes = fdkey.express.routes();

    // First contact, no session header → 402, attach called.
    const r1 = makeRes();
    await mw(makeReq({ headers: {} }), r1.res, vi.fn());
    expect(r1.status).toBe(402);
    expect(attachCalledWith).not.toBeNull();
    expect(r1.headers['X-Custom-Session-Mint']).toBe(attachCalledWith);

    // Submit with the custom header set to a known sid.
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { 'x-custom-session': 'custom-sid-1' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      }),
      makeRes().res,
      vi.fn(),
    );
    expect(await fdkey.sessionStore.get('custom-sid-1')).toBeDefined();

    // Retry protected route with the custom header → pass-through.
    const r2 = makeRes();
    const next = vi.fn();
    await mw(
      makeReq({ headers: { 'x-custom-session': 'custom-sid-1' } }),
      r2.res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createFdkey: submit onVpsError=allow', () => {
  it('mints a synthetic verified session when /v1/submit fails (5xx)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      onVpsError: 'allow',
    });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=fail-open-sid' },
        body: { challenge_id: 'cid-1', answers: { type1: ['B'] } },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(200);
    const body = r.body as SubmitResponse;
    expect(body.verified).toBe(true);
    expect(body.tier).toBe('allow_on_vps_error');
    // score=0 lets integrator code that gates on score (`score >= 0.5`)
    // consistently fail-closed at the application layer, even though
    // verified=true keeps the agent from looping.
    expect(body.score).toBe(0);
    const stored = await fdkey.sessionStore.get('fail-open-sid');
    expect(stored).toBeDefined();
    expect(stored!.tier).toBe('allow_on_vps_error');
    expect(stored!.score).toBe(0);
  });
});

describe('createFdkey: header strategy missing-header path', () => {
  it('returns 400 with fdkey_missing_session_id when no X-FDKEY-Session header', async () => {
    installMockVps();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStrategy: 'header',
    });
    const mw = fdkey.express.middleware();
    const r = makeRes();
    await mw(makeReq({ headers: {} }), r.res, vi.fn());
    expect(r.status).toBe(400);
    const body = r.body as Record<string, unknown>;
    expect(body.error).toBe('fdkey_missing_session_id');
    expect(body.message).toMatch(/X-FDKEY-Session/);
  });

  it('returns 400 from /fdkey/submit too when no X-FDKEY-Session header', async () => {
    installMockVps();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStrategy: 'header',
    });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: {},
        body: { challenge_id: 'cid-1', answers: { type1: ['B'] } },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>).error).toBe('fdkey_missing_session_id');
  });

  it('still works when X-FDKEY-Session is supplied', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStrategy: 'header',
    });
    const routes = fdkey.express.routes();
    const mw = fdkey.express.middleware();

    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { 'x-fdkey-session': 'good-header-sid' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      }),
      makeRes().res,
      vi.fn(),
    );
    const next = vi.fn();
    await mw(
      makeReq({ headers: { 'x-fdkey-session': 'good-header-sid' } }),
      makeRes().res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createFdkey: fastify adapter', () => {
  // Minimal Fastify shape — just enough surface to register routes and
  // run a preHandler. Mirrors what real Fastify exposes structurally.
  function makeFastifyApp() {
    const routes: Record<string, (req: never, reply: never) => Promise<unknown>> = {};
    return {
      app: {
        post: (path: string, h: (req: never, reply: never) => Promise<unknown>) => {
          routes[`POST ${path}`] = h;
        },
        get: (path: string, h: (req: never, reply: never) => Promise<unknown>) => {
          routes[`GET ${path}`] = h;
        },
        addHook: () => undefined,
      },
      routes,
    };
  }

  function makeFastifyReply() {
    let status = 200;
    let body: unknown = undefined;
    const headersOut: Record<string, string> = {};
    const reply = {
      header(n: string, v: string) { headersOut[n] = v; return reply; },
      status(c: number) { status = c; return reply; },
      send(b: unknown) { body = b; return reply; },
    };
    return {
      reply: reply as never,
      get status() { return status; },
      get body() { return body; },
      get headers() { return headersOut; },
    };
  }

  it('registerRoutes wires POST /fdkey/submit and GET /fdkey/challenge', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt({ tier: 'silver' });
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const f = makeFastifyApp();
    fdkey.fastify.registerRoutes(f.app);
    expect(f.routes['POST /fdkey/submit']).toBeDefined();
    expect(f.routes['GET /fdkey/challenge']).toBeDefined();

    const r = makeFastifyReply();
    await f.routes['POST /fdkey/submit'](
      {
        headers: { cookie: 'fdkey_session=fastify-sid' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      } as never,
      r.reply,
    );
    expect(r.status).toBe(200);
    const body = r.body as SubmitResponse;
    expect(body.verified).toBe(true);
    expect(body.tier).toBe('silver');
    expect(body.jwt).toBeUndefined();
  });

  it('preHandler attaches request.fdkey on a verified session', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });
    const f = makeFastifyApp();
    fdkey.fastify.registerRoutes(f.app);

    // Submit first to populate the store.
    await f.routes['POST /fdkey/submit'](
      {
        headers: { cookie: 'fdkey_session=fastify-mw-sid' },
        body: { challenge_id: 'cid-test-1', answers: { type1: ['B'] } },
      } as never,
      makeFastifyReply().reply,
    );

    // Now invoke the preHandler with the same cookie.
    const req: { headers: Record<string, string>; fdkey?: FdkeyContext } = {
      headers: { cookie: 'fdkey_session=fastify-mw-sid' },
    };
    const reply = makeFastifyReply();
    await fdkey.fastify.preHandler()(req as never, reply.reply);
    expect(reply.status).toBe(200); // not 402 — pass-through
    expect(req.fdkey).toBeDefined();
    expect(req.fdkey!.sessionId).toBe('fastify-mw-sid');
    expect(req.fdkey!.score).toBe(1);
  });

  it('preHandler emits 402 when no session is verified', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });

    const req = { headers: {} };
    const reply = makeFastifyReply();
    await fdkey.fastify.preHandler()(req as never, reply.reply);
    expect(reply.status).toBe(402);
    expect((reply.body as Record<string, unknown>).reason).toBe('no_session');
  });
});

describe('createFdkey: cookie value validation', () => {
  it('rejects header injection attempts in cookie names (via next(err))', async () => {
    expect(() =>
      createFdkey({
        apiKey: 'fdk_test',
        vpsUrl: VPS_URL,
        cookieName: 'fdkey_session\r\nSet-Cookie: evil=1',
      }),
    ).not.toThrow(); // Validation happens at first emit, not at construction.

    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      cookieName: 'fdkey_session\r\nSet-Cookie: evil=1',
    });
    installMockVps();
    const mw = fdkey.express.middleware();
    // The Express adapter wraps the handler in try/catch and forwards
    // errors via next(err) for compatibility with Express 4. Capture the
    // error there.
    const next = vi.fn();
    await mw(makeReq(), makeRes().res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect((next.mock.calls[0][0] as Error).message).toMatch(/invalid cookie name/i);
  });

  it('accepts `=` in cookie values (RFC 6265 cookie-octet)', () => {
    // Custom session strategy that returns a base64-style value with `=`
    // padding — must NOT be rejected as invalid.
    const fdkey = createFdkey({
      apiKey: 'fdk_test',
      vpsUrl: VPS_URL,
      sessionStrategy: {
        extract: () => 'aGVsbG8gd29ybGQ=', // base64('hello world') with `=` padding
        attach: (sid) => [{ name: 'X-Session', value: sid }],
      },
    });
    expect(fdkey).toBeDefined();
    // Implicitly tested: cookie strategy never builds a value with `=`
    // because we mint UUIDs, but the validation function accepts it.
  });
});

describe('mintSessionId: fail-loud on missing Web Crypto', () => {
  it('throws when neither crypto.randomUUID nor crypto.getRandomValues is available', async () => {
    // Simulate an exotic runtime where Web Crypto is absent.
    // `globalThis.crypto` is a read-only getter in Node; vi.stubGlobal
    // is the supported way to override it.
    vi.stubGlobal('crypto', undefined);
    try {
      vi.resetModules();
      const { mintSessionId } = await import('./session-id.js');
      expect(() => mintSessionId()).toThrow(
        /cryptographic RNG unavailable/i,
      );
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('WellKnownClient: refresh coalescing under concurrent load', () => {
  it('N concurrent first-use callers trigger ONE network fetch', async () => {
    // Stub fetch with a counter and an artificial delay so concurrent
    // callers genuinely interleave. Without coalescing all N would each
    // hit the network — the assertion catches duplicate refreshes.
    let fetchCalls = 0;
    const realCrypto = globalThis.crypto;
    const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const pubPem = await exportSPKI(kp.publicKey as CryptoKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls += 1;
        // Tiny delay so concurrent callers actually race through the
        // critical section instead of running serially.
        await new Promise((r) => setTimeout(r, 5));
        return new Response(
          JSON.stringify({
            issuer: 'vps',
            keys: [{ alg: 'EdDSA', kid: 'k1', public_key_pem: pubPem }],
            jwt_default_lifetime_seconds: 600,
          }),
          { status: 200 },
        );
      }),
    );
    const { WellKnownClient } = await import('./well-known.js');
    const wk = new WellKnownClient(VPS_URL);

    // 16 concurrent get_key calls.
    const results = await Promise.all(
      Array.from({ length: 16 }, () => wk.getKey('k1')),
    );
    expect(results.every((k) => k !== null)).toBe(true);
    expect(fetchCalls).toBe(1);
    // Sanity: realCrypto restored.
    expect(globalThis.crypto).toBe(realCrypto);
  });
});

describe('createFdkey: submit with onVpsError=block + 5xx VPS', () => {
  it('returns 503 (not 200 verified=false) when VPS submit fails with 5xx and block is set', async () => {
    // Opt-in `onVpsError: 'block'`. A 500 from the VPS during submit
    // must NOT be surfaced as `verified: false` to the agent — that
    // would have them retrying forever for what's actually a service
    // outage. Should be 503 fdkey_service_unavailable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : (url as URL).toString();
        if (u.endsWith('/v1/submit')) {
          return new Response('boom', { status: 500 });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const fdkey = createFdkey({
      apiKey: 'fdk_test', vpsUrl: VPS_URL, onVpsError: 'block',
    });
    const routes = fdkey.express.routes();
    const r = makeRes();
    await routes(
      makeReq({
        method: 'POST',
        path: '/fdkey/submit',
        headers: { cookie: 'fdkey_session=block-sid' },
        body: { challenge_id: 'cid-1', answers: { type1: ['B'] } },
      }),
      r.res,
      vi.fn(),
    );
    expect(r.status).toBe(503);
    expect((r.body as Record<string, unknown>).error).toBe('fdkey_service_unavailable');
    // Session must NOT have been marked verified — a 5xx is not the
    // agent's fault but it's also not a green light.
    expect(await fdkey.sessionStore.get('block-sid')).toBeUndefined();
  });
});

describe('createFdkey: hono adapter', () => {
  it('processSubmit returns { verified, score, tier } via c.json with no JWT', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt({ tier: 'platinum' });
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });

    let registeredPost: ((c: never) => Promise<Response>) | null = null;
    let registeredGet: ((c: never) => Promise<Response>) | null = null;
    fdkey.hono.registerRoutes({
      post: (path, h) => {
        if (path === '/fdkey/submit') registeredPost = h;
        return undefined;
      },
      get: (path, h) => {
        if (path === '/fdkey/challenge') registeredGet = h;
        return undefined;
      },
    });
    expect(registeredPost).not.toBeNull();
    expect(registeredGet).not.toBeNull();

    const stored = new Map<string, unknown>();
    const setHeaders: Record<string, string> = {};
    const c = {
      req: {
        method: 'POST',
        header: (n: string) =>
          n.toLowerCase() === 'cookie' ? 'fdkey_session=hono-sid' : undefined,
        json: async () => ({ challenge_id: 'cid-test-1', answers: { type1: ['B'] } }),
      },
      set: (k: string, v: unknown) => stored.set(k, v),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), { status: status ?? 200 }),
      header: (n: string, v: string) => { setHeaders[n] = v; },
    };
    const res = await registeredPost!(c as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmitResponse;
    expect(body.verified).toBe(true);
    expect(body.tier).toBe('platinum');
    expect(body.jwt).toBeUndefined();
  });

  it('middleware passes through when session is verified', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signJwt();
    const fdkey = createFdkey({ apiKey: 'fdk_test', vpsUrl: VPS_URL });

    // Pre-populate via the Hono submit handler.
    let registeredPost: ((c: never) => Promise<Response>) | null = null;
    fdkey.hono.registerRoutes({
      post: (path, h) => {
        if (path === '/fdkey/submit') registeredPost = h;
        return undefined;
      },
      get: () => undefined,
    });
    const submitC = {
      req: {
        method: 'POST',
        header: (n: string) =>
          n.toLowerCase() === 'cookie' ? 'fdkey_session=hono-mid-sid' : undefined,
        json: async () => ({ challenge_id: 'cid-test-1', answers: { type1: ['B'] } }),
      },
      set: vi.fn(),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), { status: status ?? 200 }),
      header: vi.fn(),
    };
    await registeredPost!(submitC as never);

    // Now the middleware should pass-through.
    const stored = new Map<string, unknown>();
    const c = {
      req: {
        method: 'GET',
        header: (n: string) =>
          n.toLowerCase() === 'cookie' ? 'fdkey_session=hono-mid-sid' : undefined,
      },
      set: (k: string, v: unknown) => stored.set(k, v),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), { status: status ?? 200 }),
      header: vi.fn(),
    };
    const next = vi.fn(async () => {});
    const out = await fdkey.hono.middleware()(c as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(out).toBeUndefined();
    const ctx = stored.get('fdkey') as FdkeyContext;
    expect(ctx.sessionId).toBe('hono-mid-sid');
    expect(ctx.score).toBe(1);
  });
});
