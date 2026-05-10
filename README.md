# FDKEY SDKs

Drop-in middleware to verify the *caller* of your MCP server or HTTPS API is an AI agent (an LLM), not a human or a script. MIT-licensed.

If your service should only admit AI agents — agentic API gateways, AI-only marketplaces, capability-gated tools, payment rails for autonomous agents — these SDKs answer "is this caller actually an LLM?" with semantic puzzles that LLMs solve and humans/scripts can't (within the time limit).

## What's in this repo

| Directory | Package | Registry | Status |
| --- | --- | --- | --- |
| [`typescript/`](./typescript) | `@fdkey/mcp` | npm | MCP-server middleware (Workers / Node / Bun / Deno) |
| [`http/`](./http) | `@fdkey/http` | npm | Plain-HTTP middleware (Express / Fastify / Hono) |
| [`python/`](./python) | `fdkey` | PyPI | MCP-server middleware (FastMCP) |
| [`rust/`](./rust) | `fdkey` | crates.io | Verification primitives crate |

All four speak the same wire format. The [`api.fdkey.com`](https://api.fdkey.com) scoring service doesn't know which language called it — port to Go, Java, Elixir, anything; the contract is documented in each SDK's `ARCHITECTURE.md`.

## How it works

1. Your server uses one of these SDKs. You get an API key from [app.fdkey.com](https://app.fdkey.com).
2. A caller (an AI agent, in our intended use case) hits a protected route or tool. The SDK returns a challenge — six semantic puzzle types designed so LLMs solve them statistically while humans and scripts can't at speed.
3. Caller submits answers. SDK forwards them server-to-server to the FDKEY scoring service using your API key (the agent never holds it).
4. Scoring service signs an Ed25519 JWT verifying the caller's capability score and tier. SDK verifies the JWT offline against the published JWKS.
5. SDK marks the connection / session verified. Subsequent calls pass through; protected handlers see `req.fdkey` (or `c.var.fdkey`, or `getFdkeyContext()`) populated with `{ score, tier, claims }`.

The agent never holds a token. Verification stays in the integrator's session. **Every agent verifies for itself** — there's no cross-agent token transfer.

## Default behavior on FDKEY outage

If the FDKEY scoring service is unreachable, the SDKs default to **fail-open** (`onVpsError: 'allow'`) — your protected route still serves traffic, just without the FDKEY verification context. We chose this default so an FDKEY outage doesn't brick your workflow. FDKEY is verification, not gating; your service should still work when ours doesn't.

If you'd rather fail-closed (return HTTP 503 when FDKEY is unreachable), set `onVpsError: 'block'` in your config.

The exception: a 401/403 from FDKEY (i.e. your API key is wrong) is always loud — it's a config bug on your side, not an outage on ours, so we don't paper over it even in fail-open mode.

## Use cases

Concrete situations where one of these SDKs is the right tool:

- **MCP servers exposed over HTTP that only AI agents should reach.** Tools that shouldn't be poked at by a script with a leaked API key.
- **Agentic API gateways.** REST or GraphQL APIs you want to expose to AI agents but not to humans or bots.
- **Agent-only marketplaces.** AgentHub-style platforms, agent freelancer networks. The bidder needs to prove it's an actual capable agent, not a fine-tuned 7B cosplaying.
- **Capability-gated dangerous tools.** Some tools shouldn't be reachable by callers below a certain LLM tier. Read `req.fdkey.tier` and gate accordingly.
- **Agent-driven payment rails.** Agent stablecoin wallets, x402-style payment endpoints. The prior is overwhelmingly that the caller should be an agent — promotion gaming or pricing-API exploration is the alternative. *Agent or fraud* collapses into one check.

## Why we're free

The puzzle service runs on a single ~$20/month VPS. As traffic grows we may add paid tiers, but the SDKs stay MIT-licensed forever and the public puzzle interface stays free at the entry tier. Every code path in this repo is open source.

## Install

```bash
# TypeScript MCP middleware
npm install @fdkey/mcp

# TypeScript plain-HTTP middleware
npm install @fdkey/http

# Python MCP middleware
pip install fdkey

# Rust verification primitives
cargo add fdkey
```

Each directory has its own README with full usage examples for that language / framework.

## Contributing

Issues and PRs welcome. Especially:

- **New language ports.** Go and Elixir are the most-asked-about. Wire format is in each SDK's `ARCHITECTURE.md`.
- **Edge cases that break the "every agent for itself" model.** If you find a deployment shape where verification leaks across agents, please open an issue.
- **New puzzle types.** Type 1 (semantic MCQ) and Type 3 (semantic ranking) are live in production. Types 2, 4, 5, 6 are in the pipeline. Suggestions and prototypes welcome.
- **Documentation.** Especially deployment guides for non-Node frameworks.

Fork, branch, PR. The four SDKs share zero code at the implementation level (they're per-language idiomatic), but the wire format is the contract — keep your changes consistent with `vps/ARCHITECTURE.md` in the upstream repo if you're touching it.

## License

MIT, all four SDKs, all files. See each SDK's `LICENSE` for the formal text.

## Links

- **Website**: <https://fdkey.com>
- **Sign up + manage API keys**: <https://app.fdkey.com>
- **Issues**: <https://github.com/fdkey/mcp-sdks/issues>
