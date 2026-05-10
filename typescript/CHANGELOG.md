# Changelog

All notable changes to `@fdkey/mcp` will be documented in this file.

## 0.2.0 — 2026-05-09

### Added

- **Cloudflare Workers / Bun / Deno support** on the default routing path.
  The single-VPS `StaticRouter` now uses the runtime's global `fetch` and
  imports zero Node-only dependencies. Multi-VPS routing (set via
  `discoveryUrl`) still uses `undici` for IP-pinning and is lazy-loaded
  via dynamic `import()`, so Workers bundles never pull undici unless the
  integrator explicitly opts in. `undici` moved from `dependencies` to
  `optionalDependencies`.
- **`score` and `tier` as first-class fields on `FdkeyContext`.**
  Previously available only inside `FdkeyContext.claims`. The wire shape
  reserves `score` as a 0..1 float for forward-compat with graduated
  capability scoring (today the value is binary 1.0/0.0).
- **Bounded session store** — sessions now evict on a 1h idle TTL with a
  hard 10k LRU cap (~2 MB max). Long-lived shared MCP servers no longer
  leak per-session memory.
- **Actionable error message** when `discoveryUrl` is set but `undici`
  is not installed.
- Internal `index.test.ts` covering: lazy-router contract, score/tier
  shape, SDK_VERSION sync, and SessionStore eviction semantics.

### Changed

- `withFdkey()` no longer reaches into a static `import './vps-router.js'`.
  The default URL is now `https://api.fdkey.com` when neither `vpsUrl`
  nor `discoveryUrl` is set.
- `getFdkeyContext()` reads via `store.peek()` — querying context no
  longer extends a session's lifetime.

### Migration from 0.1.0

No public API breaks. If you currently relied on `FdkeyContext.claims.score`
you can keep doing that, or migrate to the first-class `ctx.score` /
`ctx.tier` fields. If you use multi-VPS routing (`discoveryUrl`), make
sure `undici` is in your dependencies — it's no longer pulled in by
default.

## 0.1.0 — 2026-04-XX

Initial pre-publish release. MCP middleware: tool injection, policy gating,
Ed25519 JWT verify, IP-pinned multi-VPS routing.
