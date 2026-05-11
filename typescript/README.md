# @fdkey/mcp

> **FDKEY verification middleware for MCP servers.** Gate AI-agent access to
> your tools behind LLM-only puzzles. Drop-in for any
> [Model Context Protocol](https://modelcontextprotocol.io) server.

## What it does

- Injects two MCP tools into your server: `fdkey_get_challenge` and
  `fdkey_submit_challenge`, with stable MCP tool annotations
  (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) for client trust hints.
- Wraps the tools you want to protect — they return
  `fdkey_verification_required` until the connecting agent has solved a
  challenge.
- Talks to `https://api.fdkey.com` for challenge issuance and scoring.
- Verifies the Ed25519 JWT response **offline** using the public key from
  `https://api.fdkey.com/.well-known/fdkey.json`.

The agent never handles a token. The connection itself becomes verified —
verification state lives server-side in the integrator's process, keyed by
the MCP session id. Every agent verifies for itself; verification doesn't
transfer between agents.

**The SDK is puzzle-agnostic.** All agent-facing prose (puzzle text,
per-type instructions, wire-format examples, timing framing) is rendered
server-side by the VPS and passed through verbatim as the
`fdkey_get_challenge` tool result. Adding a new puzzle type or changing
an answer format is a VPS-only concern — no SDK release needed.

## Runtime support

| Runtime              | Default (single-VPS) | `discoveryUrl` set (multi-VPS) |
| -------------------- | :------------------: | :----------------------------: |
| Node 18+             | ✅                    | ✅                              |
| Cloudflare Workers   | ✅                    | ❌ (requires `undici`, Node-only) |
| Bun                  | ✅                    | ✅                              |
| Deno                 | ✅                    | ⚠️ untested                     |

By default the SDK runs on the global `fetch` and pulls in zero
Node-only dependencies — works on edge runtimes out of the box. The
multi-VPS routing path (set via `discoveryUrl`) is lazy-loaded and
requires `undici` (declared as an `optionalDependency`).

## Install

```bash
npm install @fdkey/mcp
```

You also need the official MCP server SDK (`@modelcontextprotocol/sdk`) — it's
declared as a `peerDependency`, so install your own version:

```bash
npm install @modelcontextprotocol/sdk
```

Get an API key at [app.fdkey.com](https://app.fdkey.com).

## Usage

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withFdkey } from '@fdkey/mcp';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

// Wrap the server. `protect` lists tool names that require verification.
withFdkey(server, {
  apiKey: process.env.FDKEY_API_KEY!,
  protect: {
    sensitive_action: { policy: 'each_call' },
    register: { policy: 'once_per_session' },
  },
});

// Register your tools as normal.
server.registerTool('sensitive_action', {
  description: 'Does something that needs verification',
  inputSchema: { /* ... */ },
}, async (args, extra) => {
  // Reaches here only if the agent has solved a challenge first.
  return { content: [{ type: 'text', text: 'verified' }] };
});

// Serve over your transport of choice (stdio, HTTP, etc.)
```

## Policies

Per-tool gating policy — passed as `{ policy: ... }` in the `protect` map:

- `'each_call'` — verification required for every invocation. Use for
  irreversible actions (payments, deletes).
- `'once_per_session'` — verification required once per connection. Use
  for account creation, signup-style flows.
- `{ type: 'every_minutes', minutes: N }` — verification good for N
  minutes after the puzzle was solved. Use as a middle ground when
  "every call" is too aggressive but "once forever" is too loose. Note
  the timer does NOT extend on calls — it expires `minutes` after the
  puzzle solve, regardless of activity.

```ts
protect: {
  delete_account:    { policy: 'each_call' },
  register:          { policy: 'once_per_session' },
  refresh_dashboard: { policy: { type: 'every_minutes', minutes: 15 } },
}
```

## Configuration reference

```ts
withFdkey(server, {
  apiKey: 'fdk_...',                          // required
  protect: { ... },                           // tool name → policy (above)
  vpsUrl?: 'https://api.fdkey.com',           // override for self-hosted
  discoveryUrl?: 'https://...endpoints.json', // multi-VPS routing (Node only; lazy-loaded)
  difficulty?: 'easy' | 'medium' | 'hard',    // default 'medium'
  onFail?: 'block' | 'allow',                 // default 'block' — what happens when puzzle is failed
  onVpsError?: 'block' | 'allow',             // default 'allow' (see below)
  inlineChallenge?: boolean,                  // default false — embed puzzle JSON in blocked-tool errors
                                              //   so the agent can submit without a separate
                                              //   `fdkey_get_challenge` round-trip
  tags?: { env: 'prod', region: 'eu' },       // free-form non-PII labels forwarded to FDKEY for analytics
  sessionStore?: SessionStore,                // override the in-memory session map (see below)
});
```

### Persistent sessions on Cloudflare Workers / Durable Objects

The default `sessionStore` is an in-memory `Map`, which is fine for stdio,
Node servers, and single-process HTTP integrations. On Cloudflare Workers
the `McpAgent` lives inside a Durable Object that **hibernates after a few
seconds of idle**; on resume, the in-memory map is gone, which silently
breaks `fdkey_get_challenge` → `fdkey_submit_challenge` if the agent
pauses too long between calls.

Pass a `SessionStore` implementation backed by `ctx.storage.sql` so
verification state survives hibernation. The SDK exposes the
`SessionStore` interface, the `SessionState` type, and a `newSession()`
factory so integrators can wire one up without duplicating the field
defaults. See the `mcp-cloudflare` demo in the FDKEY monorepo for a
reference implementation (~50 LOC, uses a Proxy on the returned state to
flush each property write to SQLite).

The SDK mutates session state via top-level assignments only — a single
`set` trap on the returned Proxy is sufficient to catch every mutation.
This contract is documented on the `SessionStore` interface and enforced
by an SDK test.

### Failure-mode defaults

`onVpsError: 'allow'` is the default — if the FDKEY scoring service is
unreachable, the protected tool falls through to your handler instead of
blocking. We chose this so an FDKEY outage doesn't brick your workflow
in the worst case (think: we shut down, your DNS can't resolve api.fdkey.com,
etc.). FDKEY is verification, not gating — your service still serves traffic
when our service is down.

If your threat model is the opposite — you'd rather drop traffic than admit
unverified callers during an outage — set `onVpsError: 'block'` and you
get HTTP-503-style errors instead.

## What FDKEY sees

- The MCP `clientInfo` your agent reports (name, version, protocol version,
  transport).
- Challenge IDs, scores, timestamps.
- Your integrator-supplied `tags`.

## Security notes

- **JWT `aud` is not validated by the SDK.** The audience claim binds the
  JWT to the integrator's `vps_users.id`, which the SDK doesn't know at
  verify time. The VPS already binds `aud` to the API key that requested
  the challenge — defense in depth — but in principle, a JWT issued for
  one FDKEY-protected service could be replayed against a different
  one within the JWT lifetime (~5 min default). Keep the JWT lifetime
  short on the VPS side if your threat model includes cross-integrator
  replay.

## What FDKEY does NOT see

- Your prompts.
- Tool inputs or outputs.
- Your end users' identities or PII.
- Anything about the agent beyond the MCP `clientInfo` it self-reports.

## Reading verification context

```ts
import { getFdkeyContext, type FdkeyContext } from '@fdkey/mcp';

server.registerTool('whoami', { /*...*/ }, async (args, extra) => {
  const ctx = getFdkeyContext(server, extra);
  if (ctx?.verified) {
    return {
      content: [{
        type: 'text',
        text: `Verified at ${ctx.verifiedAt} (score=${ctx.score}, tier=${ctx.tier})`,
      }],
    };
  }
  return { content: [{ type: 'text', text: 'Not verified yet' }] };
});
```

`FdkeyContext` shape:

```ts
interface FdkeyContext {
  verified: boolean;          // true once the agent has solved a challenge
  verifiedAt: number | null;  // ms epoch of the most recent successful verify
  score: number | null;       // 0..1 capability score (today binary 1.0/0.0)
  tier: string | null;        // VPS-issued tier label (e.g. "free", "gold")
  claims: Record<string, unknown> | null;  // raw decoded JWT, for power users
}
```

`score` is reserved as a 0..1 float for graduated capability scoring (combined T1 correctness + T3 tau + future T4-T6 frequency); today the value is effectively binary. The field shape will not change when the internal scoring grows.

## Links

- Marketing + docs: <https://fdkey.com>
- Dashboard (sign up + manage keys): <https://app.fdkey.com>
- Source: <https://github.com/fdkey/sdks>
- Issues: <https://github.com/fdkey/sdks/issues>

## License

MIT — see [LICENSE](./LICENSE).
