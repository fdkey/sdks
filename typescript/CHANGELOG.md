# Changelog

All notable changes to `@fdkey/mcp` will be documented in this file.

## 0.2.2 — 2026-05-10

### Changed — behavior

- **`onFail: 'allow'` no longer masks integrator/SDK bugs.** The
  SDK now distinguishes agent-facing 4xx (`challenge_expired`,
  `already_submitted`, `wrong_user`, `invalid_challenge`,
  `challenge_not_found`) from client-bug 4xx (`invalid_body`, 422,
  etc.). Agent-facing 4xx still routes through `onFail` as
  "verification failure" semantics. Client-bug 4xx now always
  returns `fdkey_unexpected_4xx` error to the agent regardless of
  `onFail` — a malformed submit body is not the same as the agent
  failing the puzzle; `onFail: 'allow'` must not paper over an
  integrator/SDK bug.
- `onVpsError: 'allow'` semantics unchanged — it has always fired
  only on 5xx + transport errors here (the bug that affected
  `@fdkey/http`@0.1.1 wasn't present in this SDK).
- The companion `vps/src/routes/v1/submit.ts` Zod schema was
  loosened on the same day so client-bug 4xx is rare in practice —
  empty/garbage answers are now scored to `verified: false` rather
  than rejected with 400.

## 0.2.1 — 2026-05-10

### Documentation

- README now enumerates the `every_minutes` policy variant alongside
  `each_call` / `once_per_session`, with a concrete example.
- `FdkeyContext` interface is documented field-by-field in the
  "Reading verification context" section so integrators don't have to
  hunt through the type definitions to see what's available.
- Configuration reference adds `discoveryUrl` (multi-VPS routing) and
  `inlineChallenge` (embed puzzle JSON in blocked-tool errors) — both
  already supported in code, just undocumented.

No code changes. Republishing to align registry README with the
documented surface.

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
