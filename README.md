# FDKEY SDKs

Drop-in middleware to verify the *caller* of your MCP server or HTTPS API is an AI agent (an LLM), not a human or a script. MIT-licensed.

These SDKs answer **"is this caller actually an LLM?"** with semantic puzzles that LLMs solve and humans / scripts can't (within the time limit). Concrete situations where that's the right question:

- **MCP servers over HTTP that only AI agents should reach.** Tools that shouldn't be poked at by a script with a leaked API key, or by a curious developer probing your endpoints.
- **News feeds, coupon APIs, partial-data endpoints** you're willing to share with an end-user's personal AI agent but not with a scraper. Reading agents (and the people they shop / research / browse for) get the data; bulk-collection bots don't.
- **Agentic API gateways.** REST or GraphQL APIs you want to expose to AI agents but not to humans or bots. A "Register as AI agent" button on your dashboard, FDKEY behind it, and your `/api/*` routes are agent-only.
- **Agent-only sites.** Whole properties — agent freelancer networks, AI-first marketplaces, agent-coordination tooling — where every connecting client should be an LLM-driven session.
- **Capability-gated dangerous tools.** Some tools shouldn't be reachable by callers below a certain LLM tier. Read `req.fdkey.tier` (or `getFdkeyContext().tier`) and gate accordingly — `gold` for the destructive tools, anything verified for the safe ones.

> **Project home:** [github.com/fdkey](https://github.com/fdkey) · **Try the demo:** [fdkey.com](https://fdkey.com)

## The four SDKs

| Directory | Package | Registry | Use it for |
| --- | --- | --- | --- |
| [`typescript/`](./typescript) | `@fdkey/mcp` | [npm](https://www.npmjs.com/package/@fdkey/mcp) | MCP servers in Node, Cloudflare Workers, Bun, Deno |
| [`http/`](./http) | `@fdkey/http` | [npm](https://www.npmjs.com/package/@fdkey/http) | Plain HTTP backends — Express, Fastify, Hono |
| [`python/`](./python) | `fdkey` | [PyPI](https://pypi.org/project/fdkey/) | MCP servers built on FastMCP |
| [`rust/`](./rust) | `fdkey` | [crates.io](https://crates.io/crates/fdkey) | Verification primitives — bring your own framework |
| [`go/`](./go) | — | — | Module path reserved (`github.com/fdkey/sdks/go`); not yet implemented. Want to write it? See [Contributing](./CONTRIBUTING.md). |

All SDKs speak the same wire format. The scoring service at [`api.fdkey.com`](https://api.fdkey.com) doesn't know which language called it — port to whatever you need; the contract is documented in each SDK's `ARCHITECTURE.md`.

## Install

```bash
# TypeScript: MCP middleware
npm install @fdkey/mcp

# TypeScript: plain-HTTP middleware
npm install @fdkey/http

# Python (FastMCP)
pip install fdkey

# Rust (verification primitives)
cargo add fdkey
```

Get an API key at [app.fdkey.com](https://app.fdkey.com).

## Quick start

### MCP server (TypeScript)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withFdkey } from '@fdkey/mcp';

const server = withFdkey(
  new McpServer({ name: 'my-server', version: '1.0.0' }),
  {
    apiKey: process.env.FDKEY_API_KEY!,
    protect: {
      sensitive_action: { policy: 'each_call' },
      register:         { policy: 'once_per_session' },
    },
  },
);

server.registerTool('sensitive_action', { /* ... */ }, async (args, extra) => {
  // Reaches here only after the agent has solved a challenge.
  return { content: [{ type: 'text', text: 'verified' }] };
});
```

### HTTP backend (TypeScript)

```ts
import express from 'express';
import { createFdkey } from '@fdkey/http';

const app = express();
app.use(express.json());

const fdkey = createFdkey({ apiKey: process.env.FDKEY_API_KEY! });
app.use(fdkey.express.routes());                   // mounts /fdkey/submit + /fdkey/challenge
app.use('/api/protected', fdkey.express.middleware());

app.get('/api/protected/whoami', (req, res) => {
  res.json({ score: req.fdkey?.score, tier: req.fdkey?.tier });
});
```

### MCP server (Python / FastMCP)

```python
import os
from mcp.server.fastmcp import FastMCP
from fdkey import with_fdkey

server = FastMCP("my-server")
with_fdkey(
    server,
    api_key=os.environ["FDKEY_API_KEY"],
    protect={"sensitive_action": {"policy": "each_call"}},
)

@server.tool()
def sensitive_action() -> str:
    return "verified"
```

### Rust (primitives)

The Rust crate ships verification primitives, not a framework wrapper. The Rust MCP ecosystem has multiple competing SDKs (`rmcp`, `mcp-server-rs`, `tower-mcp`, hand-rolled), so wrapping any one of them isn't worth the maintenance cost. Plug `Verifier` and the `guard` module into whichever server framework you're using.

```rust
use fdkey::{Verifier, FdkeyConfig, jwt::extract_bearer};

let cfg = FdkeyConfig {
    api_key: std::env::var("FDKEY_API_KEY")?,
    ..Default::default()
};
let verifier = Verifier::new(&cfg)?;

// Inside your HTTP handler, given an Authorization header value:
if let Some(token) = extract_bearer(Some("Bearer eyJ...")) {
    let claims = verifier.verify_token(token).await?;
    println!("score={}, tier={}", claims.score, claims.tier);
}
```

The Rust README has integrator obligations spelled out — see [`rust/README.md`](./rust/README.md). Briefly: never echo the JWT to the agent, use UUIDs for session keys, bound your session store with TTL + LRU.

## How it works (short version)

1. Your server uses one of these SDKs. You get an API key from `app.fdkey.com`.
2. A caller hits a protected route or tool. The SDK returns a challenge — six semantic puzzle types (MCQ, contradiction, ranking, rule induction, multi-constraint, untranslatable concept) designed so LLMs solve them statistically and humans / scripts can't at speed.
3. The caller submits answers. The SDK forwards them server-to-server to `api.fdkey.com` using your API key (the agent never holds it).
4. `api.fdkey.com` signs an Ed25519 JWT verifying the caller's capability score and tier. The SDK verifies it offline against the published JWKS at `api.fdkey.com/.well-known/fdkey.json`.
5. Session is marked verified server-side. Subsequent calls pass through; protected handlers see `req.fdkey` (or `c.var.fdkey`, or `getFdkeyContext()`) populated with `{ score, tier, claims }`.

**The agent never holds a token.** Every agent verifies for itself; verification doesn't transfer between agents.

## What happens if FDKEY goes down?

Default is **fail-open** (`onVpsError: 'allow'`) — your protected route still serves traffic, just without the FDKEY verification context. I picked this default so an FDKEY outage doesn't brick anyone's workflow. FDKEY is verification, not gating; your service should still work when mine doesn't.

If you'd rather fail-closed (return HTTP 503 when FDKEY is unreachable), set `onVpsError: 'block'`.

The exception: if the FDKEY VPS rejects your API key (HTTP 401 / 403), the SDK always returns a loud 503 with a clear message — that's a config bug on your side, not an outage on mine, so the SDK doesn't paper over it even in fail-open mode.

## Wire format compatibility

All four SDKs share the same wire format:

- `POST /v1/challenge` body: `{ difficulty, client_type, agent?, integrator?, tags? }`
- `POST /v1/submit` body: `{ challenge_id, answers }`
- JWT header: `{ alg: "EdDSA", kid: "..." }`
- JWT payload: `{ sub, aud, iss, iat, nbf, exp, score, threshold, tier, puzzle_summary, ... }`
- `/.well-known/fdkey.json` shape: `{ issuer, keys: [{ alg, kid, public_key_pem }], jwt_default_lifetime_seconds }`

If you're porting to a new language (Go, Java, Elixir, anything), the wire format above plus each SDK's `ARCHITECTURE.md` is the contract.

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to run the per-SDK test suites (vitest / pytest / cargo test), conventions, and what's in / out of scope. The most-asked-about port today is **Go** — the module path is reserved, the wire format is documented, and the implementation is up for grabs.

Issues and discussions also welcome — especially edge cases that break the "every agent for itself" model, or new puzzle types for the rotation.

## License

MIT, all four SDKs, all files. See each SDK's `LICENSE` for the formal text.

## Links

- **Project home / try it**: <https://fdkey.com>
- **Sign up + manage API keys**: <https://app.fdkey.com>
- **Live demo MCP server**: <https://mcp.fdkey.com/mcp>
- **Issues**: <https://github.com/fdkey/sdks/issues>
