# Changelog

All notable changes to `@fdkey/mcp` will be documented in this file.

## 0.2.6 — 2026-05-11

### Fixed — double-wrapped submit body from MCP agents

The VPS's `example_submission` field is the HTTP wire shape (`{body: {challenge_id, answers}}`).
MCP agents reading that field copied the entire `body` object into the
`fdkey_submit_challenge` tool's `answers` argument, producing
`{answers: {challenge_id: "...", answers: {type1, type3}}}` — double-wrapped
because the MCP tool's argument is itself named `answers`. VPS rejected the
submit with `invalid_body`. Confirmed by Claude Desktop's 2026-05-11 retest:
1st-try success on the timing front (HEADER guidance worked), but the
example still misled the format.

- **SDK now reshapes `example_submission` for MCP consumers.** The VPS keeps
  emitting the canonical HTTP body (for REST integrators); the SDK rewrites
  it before returning the get_challenge result to the agent. New shape:
  `{ _note, tool_call_arguments: { answers: {...} } }`. The key
  `tool_call_arguments` can't be confused with the tool's argument name,
  and `challenge_id` is omitted (SDK injects from session).
- `fdkey_submit_challenge` tool description updated to point at
  `example_submission.tool_call_arguments` and spell out "do NOT pass
  challenge_id".

No VPS change required.

## 0.2.5 — 2026-05-11

### Changed — agent-facing copy to teach the 60s timing constraint

The challenge TTL is a deliberate 60s (not a bug) — speed of reasoning
is part of what the gate measures. Chatty MCP clients that interleave
puzzle-analysis prose between tool calls burn the budget on rendering
text, not thinking. The 2026-05-11 Claude test surfaced this: even
with the wire format fixed (0.2.3, 0.2.4), agents still failed on
attempts where they explained their reasoning to the user between
`get` and `submit`. This release teaches the agent the constraint
inside the tool definitions themselves.

- **`fdkey_get_challenge` description** now leads with an
  IMPORTANT TIMING block: ~60-second TTL, prose between calls counts
  against it, solve SILENTLY and submit immediately.
- **`fdkey_submit_challenge` description** references the
  `example_submission` field in the get_challenge response so the
  agent knows where to copy the wire shape from.
- **`no_active_challenge` error message** rewritten to acknowledge
  the two real causes — never-called vs already-expired — and to
  spell out "solve silently next time" as the fix. Previous wording
  said only "Call fdkey_get_challenge first" which was misleading
  for the expiry case (Claude misdiagnosed it as a different bug
  and spent investigation cycles on it).

No code-flow changes. Pure copy improvements + version bump.

## 0.2.4 — 2026-05-11

### Added — pass-through `example_submission`

- The VPS now embeds an `example_submission` object in the challenge
  response (server-side teaching aid showing the exact wire-format
  wrapper the submit body must use). The SDK was stripping it via the
  `challengePayload()` whitelist — 0.2.4 passes it through to the
  agent.
- Result: agents reading the get_challenge tool result see a literal
  example with their real challenge_id pre-filled and placeholder
  letters they replace with real answers. No more trial-and-error
  schema discovery on the 60-second clock.
- Update `ChallengeResponse` TypeScript interface (`vps-client.ts`)
  with the optional `example_submission?` field shape for type-safe
  consumption.

## 0.2.3 — 2026-05-11

### Changed — fdkey_submit_challenge tool surface

- **inputSchema is now a real template.** The `answers` field used to
  be `z.record(z.string(), z.unknown())` — a black-box "any object"
  that gave the LLM zero hints. Replaced with a typed-per-puzzle-type
  Zod schema where every field carries a `.describe()` annotation.
  The MCP client serializes this to JSON Schema and surfaces every
  description + example to the LLM. Result: a frontier model
  constructs the right body on its FIRST tool call, no
  reverse-engineering from puzzle instructions required.
- **Tool description carries a worked example.** First sentence now
  shows the literal JSON shape for a type1+type3 submission. Agents
  that skim the description (most do) see the answer before reading
  the schema.
- **type3 answer accepts both string and array.** Reflects the
  companion VPS change (same date) where Zod was loosened to accept
  `"F > A > B"` strings — faithful agents following the puzzle's
  printed instructions ("letters separated by ' > '") now submit
  successfully without having to know it's actually an array on the
  scorer side.

### Why this matters

Before 0.2.3, a frontier LLM (Claude 4.5) connected via Claude
Desktop to our demo MCP server tried 7 different submit shapes
before timing out. Each 60-second challenge expired before it could
guess correctly. The root cause was the opaque inputSchema combined
with a strict VPS that rejected the format the agent was being told
to send. With 0.2.3 + the VPS schema relaxation, the agent reads the
tool's inputSchema, sees a typed object with examples, sends the
right body the first time.

### Migration

No breaking changes. Existing integrators get richer tool
documentation surfaced to their agents automatically.

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
