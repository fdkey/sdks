/**
 * End-to-end test against a mock VPS.
 *
 * Drives the full wire flow exactly once: fdkey_get_challenge →
 * fdkey_submit_challenge → JWT verify → markVerified. Every piece talks
 * over the global `fetch`, intercepted by `vi.stubGlobal`. The Ed25519
 * keypair is generated per-test, the public key served from the mock
 * /.well-known/fdkey.json, and a real JWT is signed with the matching
 * private key. If the wire format silently drifts, this test catches it
 * before integrators hit it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withFdkey, getFdkeyContext } from './index.js';

const VPS_URL = 'https://mock-vps.test';
const KID = 'test-kid-1';

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

async function signTestJwt(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ score: 1, tier: 'gold', threshold: 0.5, ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID })
    .setIssuer('mock-vps')
    .setAudience('test-integrator')
    .setSubject('test-session-1')
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 600)
    .sign(privateKey);
}

interface MockState {
  challengeCalls: number;
  submitCalls: number;
  wellKnownCalls: number;
  lastChallengeBody: unknown;
  lastSubmitBody: unknown;
  challengeResponse: Record<string, unknown>;
  submitJwt: string | null;
}

function installMockVps(): MockState {
  const state: MockState = {
    challengeCalls: 0,
    submitCalls: 0,
    wellKnownCalls: 0,
    lastChallengeBody: null,
    lastSubmitBody: null,
    challengeResponse: {
      challenge_id: 'cid-e2e-1',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      expires_in_seconds: 300,
      difficulty: 'medium',
      types_served: ['type1', 'type3'],
      puzzles: { type1: [{ q: 'foo', options: ['a', 'b', 'c', 'd'] }] },
      header: 'go',
      footer: 'done',
    },
    submitJwt: null,
  };

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    if (u.endsWith('/.well-known/fdkey.json')) {
      state.wellKnownCalls += 1;
      return new Response(
        JSON.stringify({
          issuer: 'mock-vps',
          keys: [{ alg: 'EdDSA', kid: KID, public_key_pem: publicKeyPem }],
          jwt_default_lifetime_seconds: 600,
        }),
        { status: 200 },
      );
    }
    if (u.endsWith('/v1/challenge')) {
      state.challengeCalls += 1;
      state.lastChallengeBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(JSON.stringify(state.challengeResponse), { status: 200 });
    }
    if (u.endsWith('/v1/submit')) {
      state.submitCalls += 1;
      state.lastSubmitBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({
          verified: true,
          jwt: state.submitJwt,
          types_passed: 2,
          types_served: 2,
          required_to_pass: 2,
        }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchFn);
  return state;
}

/**
 * Helper: pull a registered tool's callback off the underlying low-level
 * Server's `_registeredTools` map. We accept the private-API access here
 * because the test is a single-purpose harness, the alternative is
 * standing up a full MCP transport, and the low-level SDK has been stable
 * on this surface across releases.
 */
type ToolHandler = (
  args: unknown,
  extra: { sessionId?: string },
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function callRegisteredTool(
  server: unknown,
  name: string,
  args: unknown,
  extra: { sessionId?: string },
): Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}> {
  // McpServer holds `_registeredTools` directly (not under `.server`).
  // The handler lives under the `handler` property in the current MCP
  // SDK; older releases used `callback`. Probe both.
  //
  // Calling convention nuance: tools with NO inputSchema have a 1-arg
  // handler `(extra) => ...`; tools with an inputSchema have `(args,
  // extra) => ...`. The MCP SDK's actual dispatcher inspects fn.length
  // and adjusts. We mirror that here so both `fdkey_get_challenge`
  // (no schema) and `fdkey_submit_challenge` (has schema) work.
  const tools = (server as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (!tools) {
    throw new Error(
      'McpServer._registeredTools missing — MCP SDK private API moved',
    );
  }
  const t = tools[name] as
    | { handler?: (...a: unknown[]) => Promise<unknown>; callback?: (...a: unknown[]) => Promise<unknown> }
    | undefined;
  const fn = t?.handler ?? t?.callback;
  if (!fn) throw new Error(`tool ${name} not registered`);
  if (fn.length <= 1) {
    return fn(extra) as ReturnType<ToolHandler>;
  }
  return fn(args, extra) as ReturnType<ToolHandler>;
}

describe('e2e: full /v1/challenge → /v1/submit → JWT verify round-trip', () => {
  it('succeeds end-to-end with a valid JWT and marks the session verified', async () => {
    const mock = installMockVps();
    mock.submitJwt = await signTestJwt({ score: 1.0, tier: 'gold' });

    const server = new McpServer({ name: 'e2e-test', version: '1.0.0' });
    const wrapped = withFdkey(server, {
      apiKey: 'fdk_e2e_test',
      vpsUrl: VPS_URL,
      protect: { sensitive: { policy: 'once_per_session' } },
    });

    // 1. Agent calls fdkey_get_challenge → middleware POSTs /v1/challenge
    //    and returns puzzle JSON. SessionState gains a pending_challenge_id.
    const r1 = await callRegisteredTool(wrapped, 'fdkey_get_challenge', {}, { sessionId: 'agent-1' });
    expect(mock.challengeCalls).toBe(1);
    const body1 = mock.lastChallengeBody as Record<string, unknown>;
    expect(body1.client_type).toBe('mcp');
    expect(body1.difficulty).toBe('medium');
    const challengePayload = JSON.parse(r1.content[0].text!);
    expect(challengePayload.puzzles).toBeDefined();
    expect(challengePayload.types_served).toEqual(['type1', 'type3']);

    // 2. Agent calls fdkey_submit_challenge with answers → middleware POSTs
    //    /v1/submit, gets a JWT, verifies it offline against the mock
    //    well-known, marks the session verified.
    const answers = { type1: ['B'], type3: { q1: ['a', 'b', 'c', 'd', 'e'] } };
    const r2 = await callRegisteredTool(
      wrapped,
      'fdkey_submit_challenge',
      { answers },
      { sessionId: 'agent-1' },
    );
    expect(mock.submitCalls).toBe(1);
    expect(mock.wellKnownCalls).toBe(1);
    const body2 = mock.lastSubmitBody as Record<string, unknown>;
    expect(body2.challenge_id).toBe('cid-e2e-1');
    expect(body2.answers).toEqual(answers);
    const submitPayload = JSON.parse(r2.content[0].text!);
    expect(submitPayload.verified).toBe(true);

    // 3. Verify the SessionState carries the decoded claims with score+tier.
    const ctx = getFdkeyContext(wrapped, { sessionId: 'agent-1' });
    expect(ctx).not.toBeNull();
    expect(ctx!.verified).toBe(true);
    expect(ctx!.score).toBe(1.0);
    expect(ctx!.tier).toBe('gold');
    expect(ctx!.claims).not.toBeNull();
  });

  it('rejects when the VPS-issued JWT is not signed by the well-known key', async () => {
    const mock = installMockVps();
    // Mint a JWT signed with a DIFFERENT key (not the one in well-known).
    const otherKp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const now = Math.floor(Date.now() / 1000);
    mock.submitJwt = await new SignJWT({ score: 1, tier: 'gold' })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setIssuer('rogue').setAudience('t').setSubject('s')
      .setIssuedAt(now).setExpirationTime(now + 600)
      .sign(otherKp.privateKey as CryptoKey);

    const server = new McpServer({ name: 'e2e-test', version: '1.0.0' });
    const wrapped = withFdkey(server, {
      apiKey: 'fdk_e2e_test',
      vpsUrl: VPS_URL,
      protect: { sensitive: { policy: 'once_per_session' } },
    });

    await callRegisteredTool(wrapped, 'fdkey_get_challenge', {}, { sessionId: 'agent-2' });
    const r = await callRegisteredTool(
      wrapped,
      'fdkey_submit_challenge',
      { answers: { type1: ['A'] } },
      { sessionId: 'agent-2' },
    );
    const payload = JSON.parse(r.content[0].text!);
    expect(payload.verified).toBe(false);
    expect(payload.message).toMatch(/invalid jwt/i);

    // Session must NOT have flipped to verified.
    const ctx = getFdkeyContext(wrapped, { sessionId: 'agent-2' });
    expect(ctx!.verified).toBe(false);
    expect(ctx!.score).toBeNull();
  });
});
