# Contributing

Thanks for taking a look. FDKEY is built and maintained by a single developer; outside contributions are very welcome. This repo holds four SDKs in lockstep — they share a wire format with the scoring service at `api.fdkey.com`, but no code at the implementation level. Pick the one you want to work on.

## Repository layout

```
typescript/   @fdkey/mcp on npm  — MCP middleware (Node, Workers, Bun, Deno)
http/         @fdkey/http on npm — plain-HTTP middleware (Express, Fastify, Hono)
python/       fdkey on PyPI      — MCP middleware (FastMCP)
rust/         fdkey on crates.io — verification primitives
```

Each directory is self-contained: own `README.md`, `ARCHITECTURE.md`, tests, build config. The top-level `README.md` and this file are the only cross-cutting docs.

## Running tests

### TypeScript SDKs

```bash
cd typescript   # or http
npm install
npm run build
npm test
```

### Python SDK

```bash
cd python
python -m pip install -e ".[dev]"
python -m pytest
```

### Rust SDK

```bash
cd rust
cargo test
```

If you're on Windows without Visual Studio Build Tools, use Docker:

```bash
docker run --rm -v "$PWD:/work" -w /work rust:latest cargo test
```

## What I'd love help with

In rough priority order:

1. **Go SDK port.** The wire format is documented in each SDK's `ARCHITECTURE.md`. Start with `typescript/ARCHITECTURE.md` § 6 ("Public API surface" → "Wire format the SDK sends to the VPS") for the canonical reference.
2. **Edge cases that break "every agent for itself".** If you find a deployment shape where verification leaks across agents (e.g. a multi-tenant pattern I missed), file an issue with the repro.
3. **Framework adapters.** Want FDKEY for Koa? Hapi? Aiohttp? Tower? Open a PR adding an adapter to the relevant SDK.
4. **Documentation.** Especially deployment guides — Cloudflare Workers, Lambda, Deno Deploy, Vercel, Railway, etc.
5. **New puzzle types.** Today the SDKs serve Type 1 (semantic MCQ) and Type 3 (semantic ranking). Types 2, 4, 5, 6 are designed but not in production. The puzzle generation pipeline is in a separate repo (not yet public). If you have ideas for puzzle types that LLMs solve statistically and humans can't at speed, open a discussion.

## What's NOT in scope

- **Browser fingerprinting / behavioral signals.** Explicitly against the privacy promise; FDKEY only sees the agent's self-reported clientInfo and integrator-supplied tags. Don't add.
- **Per-IP rate limiting in the SDK.** That belongs at your edge / load balancer, not in the SDK. The SDK assumes well-behaved callers.
- **Token caching across integrators / cross-tenant token reuse.** The "agent never holds the JWT" design is deliberate. If you have a use case for cross-integrator verification, let's discuss in an issue first — it's a security-sensitive change.

## PR conventions

- One SDK per PR (don't mix TypeScript and Python changes in one PR — they have different review concerns).
- Tests required for non-trivial changes. Each SDK has its own test framework (Vitest, pytest, cargo test) — match the existing style.
- Keep the wire format consistent across SDKs. If you change something the VPS sees (e.g. a new field on the challenge body), file an issue first to coordinate the change across all four SDKs.
- README updates welcome with code changes. ARCHITECTURE.md updates required if you change a public surface.

## Code of conduct

Be kind. The contributor covenant applies — basically: assume good faith, focus on the code not the contributor, no harassment of any kind. If you see something off, email `infochvatal@gmail.com` (the maintainer).

## License

By contributing, you agree your contributions are licensed under MIT (the same license as the rest of the repo).
