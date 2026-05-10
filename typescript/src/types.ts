export type Policy =
  | { type: 'once_per_session' }
  | { type: 'each_call' }
  | { type: 'every_minutes'; minutes: number };

export type PolicyShorthand = 'once_per_session' | 'each_call';

export interface ProtectEntry {
  policy: Policy | PolicyShorthand;
}

export interface FdkeyConfig {
  /** Integrator's VPS API key (Bearer token). Required. */
  apiKey: string;
  /** Tools that require verification, keyed by tool name. */
  protect?: Record<string, ProtectEntry>;
  /** 'easy' | 'medium' | 'hard' — passed to VPS on challenge fetch. Default: 'medium' */
  difficulty?: 'easy' | 'medium' | 'hard';
  /** What happens when the agent fails the puzzle. Default: 'block' */
  onFail?: 'block' | 'allow';
  /** What happens when the FDKEY VPS is unreachable. Default: 'allow'
   *  (fail-open) — the protected tool runs as if no verification were
   *  required, so an FDKEY outage doesn't brick integrator workflows.
   *  Set to 'block' if your threat model prefers fail-closed. */
  onVpsError?: 'block' | 'allow';
  /** When true, blocked-tool errors embed the puzzle data so the agent can submit without a separate fdkey_get_challenge call. Default: false */
  inlineChallenge?: boolean;
  /** Skip discovery and use this VPS URL directly (local dev, self-hosted). */
  vpsUrl?: string;
  /** Override the Cloudflare CDN discovery URL. */
  discoveryUrl?: string;
  /** Arbitrary string-keyed dimensions forwarded to FDKEY on every
   *  challenge request, stored as `tags` on the session row. Useful for
   *  multi-tenant setups (`tenant_id`), env labels (`env: prod`), A/B
   *  experiments, deployment markers, etc.
   *
   *  IMPORTANT: tags travel to FDKEY's servers and may end up in our
   *  analytics database. **Never put end-user PII in here.** Bounded
   *  server-side at 16 keys, 50 chars/key, 200 chars/value — extra
   *  fields are rejected with HTTP 400. */
  tags?: Record<string, string>;
}

export interface SessionState {
  /** True after any successful submit on this connection. Never reset to false. */
  verified: boolean;
  /** Timestamp of the most recent successful verification (puzzle solve). */
  verifiedAt: number | null;
  /** Timestamp (ms epoch) of the last access. Drives the LRU + TTL
   *  eviction in the per-server session map so the SDK doesn't leak
   *  session entries on long-lived shared servers. Touched by every
   *  call into `getSession(...)`. */
  lastTouchedAt: number;
  /** True after a successful submit; consumed (set false) by the next each_call tool call. */
  freshVerificationAvailable: boolean;
  /** Internal: the active VPS challenge ID for this connection. Agent never sees this. */
  pendingChallengeId: string | null;
  /** Decoded JWT payload from the most recent successful verification. Surfaced to
   *  integrator tool handlers via getFdkeyContext(). The raw JWT itself is never stored. */
  lastClaims: Record<string, unknown> | null;
  /** AI client identification captured from MCP `initialize` handshake.
   *  Lazy-copied from the closure-scope `latestClientInfo` on the first tool call
   *  for this session (so it reflects whichever client most recently completed
   *  initialize on this server instance). Forwarded to the VPS on /v1/challenge. */
  clientInfo: {
    name: string;
    version: string;
    title?: string;
    capabilities?: Record<string, unknown>;
  } | null;
  /** Negotiated MCP protocol version captured from the initialize request
   *  params (e.g. "2025-03-26"). Filled by the InitializeRequestSchema
   *  interceptor in withFdkey(). */
  protocolVersion: string | null;
  /** The MCP-Session-Id header value from HTTP Streamable transport, or the
   *  literal `'stdio'` for stdio transport. Captured from `extra.sessionId` on
   *  the first tool call. Forwarded to the VPS on /v1/challenge. */
  mcpSessionId: string | null;
  /** Inferred MCP transport flavor: stdio if no sessionId on the handler extra,
   *  http otherwise, unknown if we haven't seen a tool call yet. */
  transport: 'stdio' | 'http' | 'unknown';
}

/** Agent block forwarded to the VPS in the /v1/challenge request body.
 *  Mirrors the fields stored in `vps_sessions.agent_info.agent`. */
export interface AgentMeta {
  client_name?: string;
  client_version?: string;
  client_title?: string;
  client_capabilities?: Record<string, unknown>;
  protocol_version?: string;
  mcp_session_id?: string;
  transport?: 'stdio' | 'http' | 'unknown';
}

/** Integrator block forwarded to the VPS — facts about the MCP server +
 *  SDK version that's calling us. Stored in `vps_sessions.agent_info.integrator`
 *  alongside the VPS-observed `ip` + `user_agent`. */
export interface IntegratorMeta {
  server_name?: string;
  server_version?: string;
  sdk_version?: string;
}

/** Combined per-challenge metadata bundle. Computed by withFdkey() each time
 *  a challenge is fetched and passed to VpsClient.fetchChallenge() as a single
 *  object so the wire format can grow without churning the call signature. */
export interface ChallengeMeta {
  agent?: AgentMeta;
  integrator?: IntegratorMeta;
  tags?: Record<string, string>;
}

/** Returned by `IVpsRouter.getTarget()`. Encapsulates everything a caller
 *  needs to make a TLS request that lands on the correct VPS in the fleet:
 *  a stable URL, an optional dispatcher pinned to a chosen IP (Node-only;
 *  undefined on Workers/Bun/Deno or when StaticRouter is used), and the IP
 *  itself for failure tracking.
 *
 *  `dispatcher` is typed `unknown` so this module — and any module that
 *  imports it — never touches the undici types. The runtime check happens
 *  inside vps-client.ts which casts it back when passing to fetch. */
export interface RoutingTarget {
  url: string;
  dispatcher?: unknown;
  ip?: string;
}

export interface IVpsRouter {
  getTarget(): Promise<RoutingTarget>;
  recordFailure(ip: string | undefined): void;
}

/** A VPS in the fleet, as listed in cdn.fdkey.com/endpoints.json.
 *  All FDKEY VPSs serve HTTPS for the same hostname (`api.fdkey.com`); the
 *  SDK pins each connection to a specific IP and presents `api.fdkey.com`
 *  as the SNI value, so the cert validates regardless of which IP we pick.
 *  This is the standard SDK-driven multi-region routing pattern (MongoDB
 *  driver, AWS SDK, etc.) and means adding a VPS = adding an entry here,
 *  with zero DNS work. */
export interface VpsEndpoint {
  /** Public IPv4 of the VPS. */
  ip: string;
  /** Region tag for analytics + admin-key env-var derivation. */
  region: string;
  /** Selection weight (currently informational; sort uses error+latency). */
  weight: number;
  /** Marker for graceful decommissioning. SDK ignores deprecated entries. */
  deprecated?: boolean;
}

export interface WellKnownKey {
  alg: string;
  kid: string;
  public_key_pem: string;
}

export interface WellKnownPayload {
  issuer: string;
  keys: WellKnownKey[];
  jwt_default_lifetime_seconds: number;
}

export function normalisePolicy(p: Policy | PolicyShorthand): Policy {
  if (typeof p === 'string') return { type: p };
  return p;
}
