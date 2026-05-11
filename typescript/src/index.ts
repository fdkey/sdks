import { z } from 'zod';
import { jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  FdkeyConfig,
  Policy,
  SessionState,
  ChallengeMeta,
  IntegratorMeta,
  IVpsRouter,
  RoutingTarget,
} from './types.js';
import { normalisePolicy } from './types.js';
import { canCall, markVerified, consumePolicy } from './guard.js';
import { VpsClient, VpsHttpError, type ChallengeResponse } from './vps-client.js';
import { StaticRouter } from './router-static.js';
import { createSessionStore, type SessionStore } from './session-store.js';
import { WellKnownClient } from './well-known.js';

export type { FdkeyConfig, Policy, AgentMeta, IntegratorMeta, ChallengeMeta } from './types.js';

/** @internal Test-only export. Not part of the supported public API;
 *  may change or disappear without notice. Used by `index.test.ts` to
 *  verify the lazy-import contract directly. */
export { LazyVpsRouter as __LazyVpsRouterForTesting };

/** Hardcoded SDK version. Forwarded to the VPS as `integrator.sdk_version`
 *  on every challenge fetch so we can correlate failures with SDK releases.
 *  MUST be kept in sync with package.json version on every release — there's
 *  a smoke test that checks this match. */
const SDK_VERSION = '0.2.8';

/** Default VPS URL used when no `vpsUrl` and no `discoveryUrl` are provided. */
const DEFAULT_VPS_URL = 'https://api.fdkey.com';

/** Read-only context surfaced to integrator tool handlers. */
export interface FdkeyContext {
  verified: boolean;
  verifiedAt: number | null;
  /** Capability score from the most recent verification, in [0, 1].
   *  Today this is effectively binary (1.0 = passed, 0.0 = failed); the
   *  type signature reserves the float so future capability scoring
   *  (combined T1 correctness + T3 tau + T4-T6 frequency) can land
   *  without an API change. Null until first successful verify. */
  score: number | null;
  /** VPS-issued tier label from the most recent verification (e.g.
   *  capability bucket the agent fell into). Null until first verify. */
  tier: string | null;
  /** Decoded JWT payload from the most recent verification. Includes
   *  `score`, `tier`, `puzzle_summary`, etc. Null until first successful verify. */
  claims: Record<string, unknown> | null;
}

/** Lazy wrapper around the multi-VPS `VpsRouter`. Defers `await import('./vps-router.js')`
 *  until the first `getTarget()` call so Workers/Bun/Deno builds — which never hit this
 *  path unless `discoveryUrl` is set — don't pull undici into the bundle.
 *
 *  If `undici` is not installed (it's an `optionalDependency`), the dynamic
 *  import will fail. We catch that and rethrow with a clear, actionable
 *  error so the integrator doesn't have to debug a `Cannot find module
 *  'undici'` stack trace. */
class LazyVpsRouter implements IVpsRouter {
  private inner: IVpsRouter | null = null;
  constructor(private readonly discoveryUrl: string | undefined) {}
  async getTarget(): Promise<RoutingTarget> {
    if (!this.inner) {
      try {
        const { VpsRouter } = await import('./vps-router.js');
        this.inner = new VpsRouter(this.discoveryUrl);
      } catch (err) {
        // We want to rethrow with a friendly message ONLY for the specific
        // case "undici not installed" (the optionalDependency wasn't
        // resolved). Match the Node module-resolution error code AND the
        // module name so an unrelated bundler glitch on `vps-router.js`
        // itself doesn't surface a misleading "install undici" error.
        const code = (err as { code?: string }).code;
        const isModuleNotFound =
          code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
        const msg = err instanceof Error ? err.message : String(err);
        if (isModuleNotFound && msg.includes('undici')) {
          throw new Error(
            "@fdkey/mcp: `discoveryUrl` is set but `undici` is not installed. " +
              "Multi-VPS routing requires undici (Node-only). Run " +
              "`npm install undici` to enable it, or remove `discoveryUrl` to " +
              "use the single-VPS StaticRouter path which works on Workers/Bun/Deno."
          );
        }
        throw err;
      }
    }
    return this.inner.getTarget();
  }
  recordFailure(ip: string | undefined): void {
    if (this.inner) this.inner.recordFailure(ip);
  }
}

/** Maps the wrapped (and original) server objects to their bounded
 *  SessionStore. Use getFdkeyContext() rather than touching this directly. */
const FDKEY_REGISTRY = new WeakMap<object, SessionStore>();

/** Read the current FDKEY context for a given session. Pass either the `extra`
 *  argument from a tool handler or a session ID string. Returns null if the server
 *  was not wrapped with withFdkey() or the session doesn't exist yet.
 *
 *  Reads use `store.peek()` which does NOT slide the LRU position — querying
 *  the context shouldn't extend a session's lifetime; only actual tool calls
 *  do that. */
export function getFdkeyContext(
  server: McpServer,
  extraOrSessionId: { sessionId?: string } | string | undefined
): FdkeyContext | null {
  const store = FDKEY_REGISTRY.get(server);
  if (!store) return null;
  const sid =
    typeof extraOrSessionId === 'string'
      ? extraOrSessionId
      : extraOrSessionId?.sessionId ?? 'stdio';
  const s = store.peek(sid);
  if (!s) return { verified: false, verifiedAt: null, score: null, tier: null, claims: null };
  return {
    verified: s.verified,
    verifiedAt: s.verifiedAt,
    score: extractScore(s.lastClaims),
    tier: extractTier(s.lastClaims),
    claims: s.lastClaims,
  };
}

function extractScore(claims: Record<string, unknown> | null): number | null {
  if (!claims) return null;
  const v = claims.score;
  return typeof v === 'number' ? v : null;
}

function extractTier(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const v = claims.tier;
  return typeof v === 'string' ? v : null;
}

const GET_CHALLENGE_TOOL = 'fdkey_get_challenge';
const SUBMIT_CHALLENGE_TOOL = 'fdkey_submit_challenge';

const GET_CHALLENGE_DESC =
  'Request an AI identity verification challenge. Call when a tool returns ' +
  'fdkey_verification_required, when asked to verify, or to verify proactively. ' +
  '**60s timer starts on return.** Your VERY NEXT action after this must be a ' +
  'fdkey_submit_challenge tool call with NO intervening visible text. Reason ' +
  'internally (extended thinking if available), not in chat — visible prose burns ' +
  'the budget. Explanations come AFTER the verdict.';

const SUBMIT_CHALLENGE_DESC =
  'Submit answers to the active FDKEY challenge. **Should be your VERY NEXT tool call after fdkey_get_challenge with NO intervening visible text** (the challenge has a 60s TTL). ' +
  'Takes ONE argument named `answers` — an object grouped per puzzle type. ' +
  'Do NOT pass challenge_id; the SDK injects it from session state. ' +
  'For a typical type1+type3 challenge: ' +
  'fdkey_submit_challenge({"answers":{"type1":[{"n":1,"answer":"B"},{"n":2,"answer":"A"},{"n":3,"answer":"C"}],"type3":{"n":1,"answer":"F > A > B > G > C"}}}). ' +
  'The get_challenge response contains a `LITERAL ARGUMENTS` section with the exact JSON to use — copy it, swap in your real answers, pass it as the `answers` tool argument. ' +
  'Use the EXACT letters from each puzzle\'s options. ' +
  'On verified:true, retry the blocked tool. On verified:false, call fdkey_get_challenge to retry.';

function mkError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function mkResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

function expiresInSeconds(expiresAtIso: string): number {
  const ms = new Date(expiresAtIso).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 1000));
}

/** Reshape the VPS's `example_submission` (HTTP wire format: `{ body: { challenge_id, answers } }`)
 *  into the MCP tool-call argument shape. The VPS-canonical form misleads MCP
 *  agents: they read it, see `body.answers` looks like content, and submit
 *  `{ answers: { challenge_id, answers: {...} } }` — double-wrapped because
 *  the MCP tool's argument is itself named `answers`. Confirmed 2026-05-11
 *  (Claude Desktop). Strip `challenge_id` (the SDK injects it from session)
 *  and re-key the example to a name the agent can't conflate with the tool's
 *  argument. */
function rewriteExampleForMcp(vpsExample: unknown): unknown {
  if (!vpsExample || typeof vpsExample !== 'object') return vpsExample;
  const ex = vpsExample as { body?: { answers?: unknown } };
  const innerAnswers = ex.body?.answers;
  if (innerAnswers === undefined) return vpsExample;
  return {
    _note:
      'Call fdkey_submit_challenge with the tool_call_arguments object below as the ' +
      'tool argument. Replace the placeholder letters with your real answers. Do NOT ' +
      'include challenge_id — the SDK injects it from session state.',
    tool_call_arguments: { answers: innerAnswers },
  };
}

/** Render the challenge as a directive-shaped text content for MCP agents.
 *  Background: returning the challenge as a JSON dump triggers the agent's
 *  "narrate the tool result to the user" reflex — Claude Desktop's 2026-05-11
 *  transcript showed ~600 tokens of visible chain-of-thought between get and
 *  submit, which at 50-80 tok/s burned 8-15s of the 60s TTL before submit
 *  was queued. Direct insight from a model under test: the JSON frame
 *  pattern-matches to "tool result → explain to user"; an imperative,
 *  command-shaped string pattern-matches to "directive → function-call".
 *  This renderer reframes the response from data-to-narrate into
 *  command-to-execute: ACTION REQUIRED at line 1, puzzles and literal
 *  arguments as labeled sections, NEXT ACTION at the bottom. The VPS still
 *  emits its canonical JSON for REST integrators; this conversion is
 *  MCP-only and happens in the SDK. */
function formatChallengeForMcp(c: ChallengeResponse): string {
  const parts: string[] = [];

  const ttl = c.expires_in_seconds ?? expiresInSeconds(c.expires_at);

  parts.push(
    '⚡ ACTION REQUIRED: your NEXT response must be a fdkey_submit_challenge tool call. ' +
    'Generate NO text before that call. Reason internally only (extended thinking, ' +
    'NOT visible chat). Any visible prose burns the TTL budget. ' +
    'Save all explanation for AFTER the verdict.'
  );
  parts.push(`Timer: ~${ttl}s remaining on this challenge.`);

  parts.push('');
  parts.push('━━━ PUZZLES ━━━');

  const puzzles = c.puzzles ?? {};

  const t1 = puzzles['type1'] as
    | { instructions?: string; questions?: Array<{ n: number; question: string; options: string[] }> }
    | undefined;
  if (t1?.questions) {
    parts.push('');
    parts.push(`[Type 1] ${t1.instructions ?? ''}`);
    for (const q of t1.questions) {
      parts.push('');
      parts.push(`${q.n}. ${q.question}`);
      for (const opt of q.options) parts.push(`   ${opt}`);
    }
  }

  const t3 = puzzles['type3'] as
    | { instructions?: string; n?: number; concept?: string; options?: string[] }
    | undefined;
  if (t3?.options) {
    parts.push('');
    parts.push(`[Type 3] ${t3.instructions ?? ''}`);
    parts.push(`Concept: "${t3.concept ?? ''}"`);
    parts.push('Options:');
    for (const opt of t3.options) parts.push(`  ${opt}`);
  }

  // Literal tool arguments — extracted from the SDK-rewritten example.
  parts.push('');
  parts.push('━━━ LITERAL ARGUMENTS for fdkey_submit_challenge ━━━');
  parts.push(
    'Copy this object as the `answers` tool argument. Replace placeholder letters ' +
    'with your real answers. Do NOT include challenge_id (the SDK injects it).'
  );
  const ex = rewriteExampleForMcp(c.example_submission) as
    | { tool_call_arguments?: { answers?: unknown } }
    | undefined;
  const args = ex?.tool_call_arguments?.answers ?? {};
  parts.push('');
  parts.push('```json');
  parts.push(JSON.stringify(args, null, 2));
  parts.push('```');

  parts.push('');
  parts.push('━━━');
  parts.push('NEXT ACTION: call fdkey_submit_challenge with `answers` set to the JSON above (placeholders replaced). No prose first.');

  return parts.join('\n');
}

/**
 * Wraps an MCP server with FDKEY verification middleware.
 *
 * @example
 * const server = withFdkey(new McpServer({ name: 'my-server', version: '1.0.0' }), {
 *   apiKey: process.env.FDKEY_API_KEY!,
 *   protect: {
 *     login:    { policy: 'each_call' },
 *     register: { policy: 'once_per_session' },
 *   },
 * });
 * server.registerTool('login', { inputSchema: { username: z.string() } }, async (args) => { ... });
 */
export function withFdkey(server: McpServer, config: FdkeyConfig): McpServer {
  const protect = config.protect ?? {};
  const onFail = config.onFail ?? 'block';
  // Default is 'allow' (fail-open) so an FDKEY service outage doesn't
  // brick integrator workflows — protected tools fall through to their
  // original handler. Override with `onVpsError: 'block'` if your threat
  // model prefers fail-closed.
  const onVpsError = config.onVpsError ?? 'allow';
  const inlineChallenge = config.inlineChallenge ?? false;

  // Router selection:
  //   discoveryUrl set      → multi-VPS routing via undici-backed VpsRouter
  //                           (Node-only; lazy-imported to keep undici out
  //                            of Workers/Bun/Deno bundles)
  //   vpsUrl set            → StaticRouter pinned to that URL (default fetch)
  //   neither set           → StaticRouter at https://api.fdkey.com
  const router: IVpsRouter = config.discoveryUrl
    ? new LazyVpsRouter(config.discoveryUrl)
    : new StaticRouter(config.vpsUrl ?? DEFAULT_VPS_URL);

  const vpsClient = new VpsClient(router, config.apiKey, config.difficulty ?? 'medium');
  const wellKnown = new WellKnownClient(router);

  // Bounded per-server session store. See session-store.ts for the
  // full TTL + LRU eviction contract; the wrapped server itself only
  // sees `get()` and `peek()`.
  const store = createSessionStore();
  const getSession = (id: string) => store.get(id);

  // --- Agent metadata capture (Step 2A + 2A.5, 2026-05-02) -----------------
  // The MCP `initialize` handshake is the only protocol-level moment we get
  // structured agent identification. Two hooks combined:
  //   1. setRequestHandler(InitializeRequestSchema) — runs DURING the request
  //      (before the client's `initialized` notification), giving us the
  //      negotiated protocolVersion from the request params. We delegate to
  //      the original handler the Server registered in its constructor so
  //      the built-in init logic still runs.
  //   2. oninitialized — fires AFTER `notifications/initialized` arrives,
  //      at which point getClientVersion() + getClientCapabilities() are
  //      populated.
  //
  // For stdio: one server, one client, both hooks fire once. Stable for the
  // process. For HTTP Streamable: the typical pattern is one McpServer per
  // session, so closure-scoped `latestClientInfo` is per-session by
  // construction. The pathological shared-server race (init A → tool call
  // B → init B → tool call A on the same McpServer) is documented as a
  // known limitation — don't share Server instances across sessions if you
  // care about per-session attribution.

  type LatestInfo = {
    name: string;
    version: string;
    title?: string;
    capabilities?: Record<string, unknown>;
  };
  let latestClientInfo: LatestInfo | null = null;
  let latestProtocolVersion: string | null = null;

  // Hook (1): wrap the existing initialize handler so we can read protocolVersion
  // from the request params before delegating. The Server class registers its
  // own _oninitialize via setRequestHandler in its constructor; calling
  // setRequestHandler again replaces the entry. We retrieve the prior handler
  // through the protocol's private _requestHandlers map and re-invoke it,
  // preserving the official init behavior. Private-API access is bounded to
  // these few lines and documented; if MCP SDK refactors this away we update.
  const protocolPrivate = server.server as unknown as {
    _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  };
  const origInitialize = protocolPrivate._requestHandlers?.get('initialize');
  if (origInitialize) {
    server.server.setRequestHandler(
      InitializeRequestSchema,
      async (request, extra) => {
        try {
          // request.params.protocolVersion is what the client sent
          const pv = (request as { params?: { protocolVersion?: string } }).params?.protocolVersion;
          if (typeof pv === 'string') latestProtocolVersion = pv;
        } catch {
          // Reading the field must never break initialize; swallow errors.
        }
        return origInitialize(request, extra) as Promise<{ [k: string]: unknown }>;
      }
    );
  }

  // Hook (2): post-init capture for clientInfo + capabilities.
  const previousOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    const ci = server.server.getClientVersion();
    const caps = server.server.getClientCapabilities();
    if (ci) {
      latestClientInfo = {
        name: ci.name,
        version: ci.version,
        title: (ci as { title?: string }).title,
        capabilities: caps as Record<string, unknown> | undefined,
      };
    }
    if (previousOnInitialized) previousOnInitialized();
  };

  // Integrator-side block — same value every challenge call. Read once at
  // wrap time. server_info comes from McpServer's ctor args; the underlying
  // Server stores it as private `_serverInfo`. Accessing via type assertion
  // because there's no public getter as of MCP TS SDK 1.x.
  const serverPrivate = server.server as unknown as {
    _serverInfo?: { name?: string; version?: string };
  };
  const integratorMeta: IntegratorMeta = {
    server_name: serverPrivate._serverInfo?.name,
    server_version: serverPrivate._serverInfo?.version,
    sdk_version: SDK_VERSION,
  };

  // Tags: integrator-supplied free-form key/value dimensions. Forwarded as-is
  // on every challenge fetch. VPS bounds them at 16 keys / 50 char keys / 200
  // char values and rejects with HTTP 400 on overflow.
  const configuredTags = config.tags;

  /** Lazy-copy session-scoped agent metadata on first tool call. Idempotent —
   *  re-runs are no-ops because we use ??= guards. Returns a ChallengeMeta
   *  bundle ready to pass to vpsClient.fetchChallenge(). */
  function captureChallengeMeta(
    session: SessionState,
    extra: { sessionId?: string }
  ): ChallengeMeta {
    session.mcpSessionId ??= extra.sessionId ?? 'stdio';
    if (session.transport === 'unknown') {
      session.transport = extra.sessionId ? 'http' : 'stdio';
    }
    session.clientInfo ??= latestClientInfo;
    session.protocolVersion ??= latestProtocolVersion;

    const agent: ChallengeMeta['agent'] = {
      transport: session.transport,
      mcp_session_id: session.mcpSessionId ?? undefined,
    };
    if (session.clientInfo) {
      agent.client_name = session.clientInfo.name;
      agent.client_version = session.clientInfo.version;
      if (session.clientInfo.title) agent.client_title = session.clientInfo.title;
      if (session.clientInfo.capabilities) {
        agent.client_capabilities = session.clientInfo.capabilities;
      }
    }
    if (session.protocolVersion) agent.protocol_version = session.protocolVersion;

    return {
      agent,
      integrator: integratorMeta,
      tags: configuredTags,
    };
  }

  // --- Injected tool: fdkey_get_challenge ---
  server.registerTool(
    GET_CHALLENGE_TOOL,
    { description: GET_CHALLENGE_DESC },
    async (extra) => {
      const e = extra as { sessionId?: string };
      const session = getSession(e.sessionId ?? 'stdio');
      const meta = captureChallengeMeta(session, e);
      try {
        const challenge = await vpsClient.fetchChallenge(meta);
        session.pendingChallengeId = challenge.challenge_id;
        // Directive-shaped text content (not JSON) — see formatChallengeForMcp
        // for the rationale. JSON form triggers the agent's "narrate the tool
        // result" reflex, which burns 8-15s of the 60s budget on visible CoT.
        return { content: [{ type: 'text' as const, text: formatChallengeForMcp(challenge) }] };
      } catch (err) {
        return mkError(`fdkey_service_unavailable: ${String(err)}`);
      }
    }
  );

  // --- Injected tool: fdkey_submit_challenge ---
  //
  // The `answers` inputSchema is rich on purpose: the agent's MCP client
  // serializes this Zod schema into JSON Schema and surfaces every
  // `.describe()` annotation to the LLM. With per-field descriptions and
  // worked examples in the schema, a frontier LLM constructs the right
  // body on its FIRST attempt — no reverse-engineering of the wire shape
  // from the puzzle instructions.
  //
  // Backwards compatibility note: agents that send extra fields are fine
  // — Zod's default behavior on `z.object()` is to strip-extra, not reject.
  server.registerTool(
    SUBMIT_CHALLENGE_TOOL,
    {
      description: SUBMIT_CHALLENGE_DESC,
      inputSchema: {
        answers: z
          .object({
            type1: z
              .array(
                z.object({
                  n: z
                    .number()
                    .int()
                    .min(1)
                    .describe(
                      "Question number (1-indexed) — matches the `n` field on each item in the challenge's type1.questions array."
                    ),
                  answer: z
                    .string()
                    .describe(
                      "Single letter A-D matching the option you picked. Just the letter, e.g. 'B'. No explanation."
                    ),
                })
              )
              .describe(
                'Type 1 (multiple-choice) answers. One entry per question served. ' +
                'Example: [{"n":1,"answer":"B"},{"n":2,"answer":"A"},{"n":3,"answer":"C"}]'
              )
              .optional(),
            type2: z
              .object({
                n: z.number().int().min(1).describe('Always 1 (single T2 puzzle).'),
                answer: z.string().describe('Single letter identifying the contradiction.'),
              })
              .optional(),
            type3: z
              .object({
                n: z
                  .number()
                  .int()
                  .min(1)
                  .describe('Always 1 (single T3 puzzle per challenge).'),
                answer: z
                  .union([
                    z
                      .string()
                      .describe(
                        "Letters separated by ' > '. Example: 'F > A > B > G > C'."
                      ),
                    z
                      .array(z.string())
                      .describe(
                        'Array of letter strings. Example: ["F","A","B","G","C"].'
                      ),
                  ])
                  .describe(
                    'Ranking from MOST to LEAST conceptually similar to the concept. ' +
                    'EITHER a string ("F > A > B > G > C") or an array (["F","A","B","G","C"]) accepted.'
                  ),
              })
              .describe(
                'Type 3 (semantic ranking) answer. ' +
                'Example: {"n":1,"answer":"F > A > B > G > C"}'
              )
              .optional(),
            type4: z
              .object({
                n: z.number().int().min(1),
                answer: z
                  .string()
                  .describe('Single word — the rule you induced from the examples.'),
              })
              .optional(),
            type5: z
              .object({
                n: z.number().int().min(1),
                answer: z
                  .string()
                  .describe('Single word satisfying all the constraints.'),
              })
              .optional(),
            type6: z
              .object({
                n: z.number().int().min(1),
                answer: z
                  .string()
                  .describe('Single word for the untranslatable concept.'),
              })
              .optional(),
          })
          .describe(
            'Answers grouped by puzzle type. Only include types that were served in your challenge ' +
            '(see `types_served` on the challenge response). Each type has its own answer shape.'
          ),
      },
    },
    async (args, extra) => {
      const session = getSession((extra as { sessionId?: string }).sessionId ?? 'stdio');
      if (!session.pendingChallengeId) {
        // Two real causes for this state:
        //  (a) the agent submitted before calling fdkey_get_challenge.
        //  (b) the agent's prose generation between get and submit
        //      exceeded the ~60s TTL, the SDK already submitted (or
        //      cleared state) on a previous failed attempt, and this
        //      is the second-attempt no-op.
        // Either way the recovery is the same — fetch a fresh
        // challenge — but the message has to make (b) discoverable
        // so the agent learns to solve silently next time.
        return mkResult({
          verified: false,
          error: 'no_active_challenge',
          message:
            `No active challenge in this session. Either ${GET_CHALLENGE_TOOL} ` +
            `was never called, OR a previous challenge already expired (TTL is ~60s, ` +
            `including any prose you generate between tool calls). ` +
            `Call ${GET_CHALLENGE_TOOL} to start a fresh one, then submit ` +
            `IMMEDIATELY without writing analysis prose in between — the clock ` +
            `is running.`,
        });
      }

      let result: Awaited<ReturnType<VpsClient['submitAnswers']>>;
      try {
        result = await vpsClient.submitAnswers(
          session.pendingChallengeId,
          args.answers as Record<string, unknown>
        );
      } catch (err) {
        session.pendingChallengeId = null;
        if (err instanceof VpsHttpError && err.body.error === 'challenge_expired') {
          return mkResult({
            verified: false,
            error: 'challenge_expired',
            message: `Challenge expired. Call ${GET_CHALLENGE_TOOL} to start a new one.`,
          });
        }
        if (err instanceof VpsHttpError && err.status >= 400 && err.status < 500) {
          // Distinguish agent-facing 4xx (the agent's submission is in a bad
          // state — expired, replayed, wrong session) from client-bug 4xx
          // (the SDK sent a malformed body — invalid_body, 422, etc.).
          //
          // Agent-facing 4xx → `onFail` decides (skip-or-block). These are
          // ordinary verification failures the agent can recover from with
          // a fresh challenge.
          //
          // Client-bug 4xx → ALWAYS error out loudly. The agent failing the
          // puzzle is not the same as the SDK sending garbage; `onFail:
          // 'allow'` should never paper over an integrator/SDK bug.
          const errCode = typeof err.body.error === 'string' ? err.body.error : '';
          const AGENT_FACING_4XX = new Set([
            'challenge_expired', 'already_submitted', 'wrong_user',
            'invalid_challenge', 'challenge_not_found',
          ]);
          if (AGENT_FACING_4XX.has(errCode)) {
            if (onFail === 'allow') {
              markVerified(session);
              return mkResult({ verified: true, message: 'Verification skipped per server configuration.' });
            }
            return mkResult({ verified: false, error: errCode || 'verification_failed' });
          }
          // Other 4xx (invalid_body, 422, 404, etc.) — integrator/SDK bug.
          // Surface loudly regardless of onFail/onVpsError. Per the README
          // contract: fail-open is for VPS UNREACHABLE, not "your body is
          // wrong".
          return mkError(
            `fdkey_unexpected_4xx: FDKEY VPS returned HTTP ${err.status} ${errCode}. ` +
            `This is an integrator/SDK bug, not a VPS outage. ` +
            `Check the wire format. (${String(err)})`
          );
        }
        // 5xx or transport error
        if (onVpsError === 'allow') {
          markVerified(session);
          return mkResult({ verified: true, message: 'VPS unreachable — access allowed per server configuration.' });
        }
        return mkError(
          `fdkey_service_unavailable: verification service is temporarily unreachable. Retry in a few seconds or contact the server operator. (${String(err)})`
        );
      }

      session.pendingChallengeId = null;

      if (result.verified && result.jwt) {
        try {
          const header = decodeProtectedHeader(result.jwt);
          const kid = header.kid as string | undefined;
          if (!kid) throw new Error('JWT missing kid header');
          const pubKey = await wellKnown.getKey(kid);
          if (!pubKey) throw new Error(`Unknown key id: ${kid}`);
          // 30s clock tolerance — covers NTP drift between the VPS and the SDK host.
          // Without this, JWTs with `nbf` slightly in the future (issuer clock ahead)
          // get rejected by recipients with slightly slower clocks.
          await jwtVerify(result.jwt, pubKey, { clockTolerance: 30 });
          // Cache decoded claims so getFdkeyContext() can surface them to integrator handlers (G3)
          session.lastClaims = decodeJwt(result.jwt) as Record<string, unknown>;
        } catch (jwtErr) {
          if (onFail === 'allow') {
            markVerified(session);
            return mkResult({ verified: true, message: 'Verification passed (JWT validation skipped).' });
          }
          return mkResult({
            verified: false,
            message: `Verification failed: invalid JWT — ${String(jwtErr)}`,
          });
        }
        markVerified(session);
        return mkResult({ verified: true, message: 'Verification passed. You can now access protected tools.' });
      }

      // VPS responded 200 with verified=false
      if (onFail === 'allow') {
        markVerified(session);
        return mkResult({ verified: true, message: 'Verification failed but access allowed per server configuration.' });
      }
      return mkResult({ verified: false, message: 'Verification failed. Call fdkey_get_challenge to try again.' });
    }
  );

  // --- Proxy: intercept registerTool() and deprecated tool() to gate protected tools ---
  function makeInterceptor(targetFn: (...a: unknown[]) => unknown) {
    return function (...toolArgs: unknown[]) {
      const name = toolArgs[0] as string;

      // Our injected tools are already registered — pass through unchanged
      if (name === GET_CHALLENGE_TOOL || name === SUBMIT_CHALLENGE_TOOL) {
        return Reflect.apply(targetFn, server, toolArgs);
      }

      const entry = protect[name];
      if (!entry) {
        return Reflect.apply(targetFn, server, toolArgs);
      }

      const idx = toolArgs.length - 1;
      const original = toolArgs[idx] as (...cbArgs: unknown[]) => Promise<unknown>;
      const policy: Policy = normalisePolicy(entry.policy);

      toolArgs[idx] = async (...cbArgs: unknown[]) => {
        // extra is always the last cb arg: (args, extra) or (extra) for no-arg tools
        const extra = cbArgs[cbArgs.length - 1] as { sessionId?: string };
        const session = getSession(extra?.sessionId ?? 'stdio');
        // Capture client info on every protected-tool call too — the agent
        // may hit a gated tool before fdkey_get_challenge runs (the natural
        // first-blocked-then-verify flow), and we still want metadata.
        const meta = captureChallengeMeta(session, extra ?? {});

        if (canCall(policy, name, session)) {
          const result = await original(...cbArgs);
          consumePolicy(policy, session);
          return result;
        }

        if (inlineChallenge) {
          try {
            const challenge = await vpsClient.fetchChallenge(meta);
            session.pendingChallengeId = challenge.challenge_id;
            return mkError(
              `fdkey_verification_required. Solve the challenge below then call ${SUBMIT_CHALLENGE_TOOL}, then retry this tool.\n\n` +
                formatChallengeForMcp(challenge)
            );
          } catch {
            if (onVpsError === 'allow') return original(...cbArgs);
            return mkError(
              'fdkey_service_unavailable: verification service is temporarily unreachable. Retry in a few seconds or contact the server operator.'
            );
          }
        }

        return mkError(
          `fdkey_verification_required. Call ${GET_CHALLENGE_TOOL} to start verification, then ${SUBMIT_CHALLENGE_TOOL} with your answers, then retry this tool.`
        );
      };

      return Reflect.apply(targetFn, server, toolArgs);
    };
  }

  const wrapped = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return makeInterceptor(target.registerTool as (...a: unknown[]) => unknown);
      }
      if (prop === 'tool') {
        return makeInterceptor(target.tool as (...a: unknown[]) => unknown);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // Register both the original and the wrapped reference so getFdkeyContext()
  // works regardless of which the integrator passes.
  FDKEY_REGISTRY.set(server, store);
  FDKEY_REGISTRY.set(wrapped, store);
  return wrapped;
}
