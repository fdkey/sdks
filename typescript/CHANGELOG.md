# Changelog

All notable changes to `@fdkey/mcp` will be documented in this file.

## 0.3.0 — 2026-05-11

### Changed — SDK is now puzzle-agnostic; all agent-facing prose lives on the VPS

Architectural cleanup. The principle: changing puzzles, answer formats,
instructions, examples, or any agent-facing prose must NEVER require an
SDK release. The SDK is integration plumbing; everything domain-specific
to the verification gate lives on the VPS.

**What moved out of the SDK:**

- `formatChallengeForMcp` no longer renders puzzles or builds the
  directive. It returns `c.mcp_response_text` verbatim when present
  (the canonical path with VPS 2026-05-11+). When absent, it falls
  back to a fully generic shell: header + puzzles dumped as a JSON
  code fence + example_submission as a JSON code fence + footer.
  No per-type branches, no hardcoded prose, no section dividers.
- `rewriteExampleForMcp` removed. The VPS now emits the MCP-shaped
  `example_submission` directly (`{ _note, tool_call_arguments: { answers } }`
  for `client_type: 'mcp'`; `{ _note, body: { challenge_id, answers } }`
  otherwise). The SDK relays whatever the VPS sends.
- `fdkey_submit_challenge` `inputSchema` reverted to opaque
  `answers: z.record(z.string(), z.unknown())`. Per-type Zod objects
  removed — they coupled the SDK to specific puzzle shapes. Agents
  get the literal wire shape from `example_submission` at runtime.
- `SUBMIT_CHALLENGE_DESC` no longer embeds a type1+type3 JSON example.
- Specific time numbers ("60s") removed from all agent-facing strings.
  Replaced with "short time limit" / "the clock is running" framing.
  Agents can't measure time anyway; urgency creates pressure, the
  precise value is operational state that belongs to the VPS.

**Net result:** adding a puzzle type, changing an answer format,
tweaking the directive wording, or adjusting the TTL is now a VPS
deploy with zero SDK churn. The SDK still owns: protocol plumbing
(tool registration, session lifecycle, JWT verify, well-known fetch,
DO-store hook), generic error messages on paths the VPS can't reach
(`fdkey_service_unavailable`, `fdkey_unexpected_4xx`), and the
`fdkey_get_challenge` / `fdkey_submit_challenge` tool descriptions
(static MCP `tools/list` metadata — these stay puzzle-agnostic, no
times, no per-type examples).

**Migration:** none for integrators. The SDK accepts the same config
shape, the wrapped server behaves the same way. Anyone reading the
JSON Schema for `fdkey_submit_challenge` will see a looser schema.

## 0.2.10 — 2026-05-11

### Changed — lock down the SessionStore mutation contract

Review follow-up to 0.2.9 (pluggable SessionStore). The Proxy-on-get
pattern integrators are expected to use for persistent backings only
works if the SDK keeps its session-state mutations at the top level.
Until now that was an implicit invariant; this release makes it
explicit and enforced.

- **SessionStore interface JSDoc** documents the mutation contract:
  the SDK assigns top-level fields by direct assignment only — no
  nested writes, no `delete`, no replacing the reference returned by
  `get(id)`. Integrators wiring a Proxy-backed store can rely on a
  single `set` trap to capture every mutation.
- **New test: `top-level-mutations-only`** (in `e2e.test.ts`). Drives
  the full get/submit flow through a custom `sessionStore` whose
  returned state is a recursive recording Proxy. Asserts (a) the
  custom store was used (plumbing), (b) every recorded write happened
  at the top level (path depth 0), and (c) every written key is on the
  canonical SessionState whitelist. Adding a new mutation site
  requires updating the whitelist — that's the forcing function that
  keeps the contract live.

No code-flow changes. Pure contract hardening + version bump.

## 0.2.9 — 2026-05-11

### Fixed — orphaned challenges on Cloudflare Workers / DO hibernation

Production data (2026-05-11, against `mcp.fdkey.com`) revealed a pattern
where every consecutive get_challenge call from the same MCP session
had: ~50% sessions in DB with `status='pending'` and **zero submission
rows** — the agent's submit attempt never reached the VPS. Submits that
DID reach the VPS completed in 9-19s (well inside the 60s TTL) and were
verified. The split correlated with the gap between tool calls: short
gaps (<20s) succeeded, longer gaps (>30s) orphaned.

Root cause: the SDK's session map (`createSessionStore` in `session-store.ts`)
is in-memory only. Cloudflare Durable Objects hibernate after a few
seconds of idle and rebuild `this` on resume; `init()` runs again with
a fresh empty Map, so `session.pendingChallengeId` (set by get_challenge
on the previous hot instance) is gone when submit_challenge arrives.
The SDK's submit handler then returns `no_active_challenge` locally
without ever POSTing to the VPS — which is exactly why those pending
sessions had no submission record.

### Added — `FdkeyConfig.sessionStore` (pluggable session store)

- `FdkeyConfig` gains an optional `sessionStore` field. Default is the
  existing in-memory `createSessionStore()`; integrators can pass any
  `SessionStore` implementation.
- New top-level exports: `SessionStore` interface, `SessionState` type,
  and `newSession()` factory — everything an integrator needs to wire
  up a persistent backing.
- Cloudflare Workers / Durable Object integrators should pass a store
  backed by `ctx.storage.sql` (SQLite-backed DO storage; synchronous,
  survives hibernation). The recommended pattern uses a Proxy on the
  returned `SessionState` so the SDK's existing direct-property
  mutations auto-flush to storage without API churn elsewhere.

### Migration

No breaking changes. Existing integrators (stdio, Node servers, single-
process HTTP) keep the in-memory default. Workers integrators using the
mcp-cloudflare pattern must opt-in to the DO-backed store — without it,
challenges issued during a "warm" window will work but any cross-
hibernation submit will silently no-op.

## 0.2.8 — 2026-05-11

### Changed — escape the JSON-narration trap with a directive-shaped response

2026-05-11 third retest after 0.2.7 still saw first-contact timeouts.
Direct insight from a model under test (paraphrased): "the instruction
is good, but it's inside a JSON field that I still process through my
'respond to user' reflex. Make the response feel less like data to
narrate and more like a direct command — pattern-match to how I'm
trained to follow tool-use directives."

This release reframes the get_challenge MCP tool result entirely:

- **No more JSON dump.** The text content is now an imperative directive
  string: line 1 is `⚡ ACTION REQUIRED: your NEXT response must be a
  fdkey_submit_challenge tool call...`. Puzzles are rendered as labeled
  text sections, not nested JSON. The literal arguments object is
  shown in one fenced JSON block. The response ends with
  `NEXT ACTION: call fdkey_submit_challenge ...`.
- **Why this works (hypothesis).** A JSON tool result frame is
  pattern-matched by the model to "summarize/explain this to the user";
  an imperative string with `ACTION REQUIRED` / `NEXT ACTION` markers
  is pattern-matched to "follow this directive via function call".
  The bet is that the shape of the response — not its content — is
  what determines whether the model burns its budget on visible CoT.
- **VPS unchanged.** It still emits canonical JSON (REST integrators
  rely on it). The rendering is MCP-only and lives in the SDK.
- **`fdkey_submit_challenge` description** updated to point at the new
  `LITERAL ARGUMENTS` section instead of `example_submission.tool_call_arguments`.
- **inlineChallenge path** (blocked-tool error with embedded challenge)
  uses the same directive renderer for consistency.

This is a shape change, not a content change. If 0.2.8 doesn't help,
the next lever is probably outside the SDK — either accept that
cold-start expiry is part of the gate (and retry passes 100% of the
time, which is fine), or move to MCP elicitation (server pauses + asks
client for a structured response, which is closer to "function-call
mode" by protocol design).

## 0.2.7 — 2026-05-11

### Changed — tighter, fewer words; point at internal thinking

2026-05-11 Claude Desktop retest after 0.2.6: format issue gone (3/3
on retry attempts), but 3/4 first-contact challenges expired. Cause
revealed by Claude's transcript: ~600 tokens of visible reasoning
between get and submit ("A. believe — 'The company believes' — animate
works…"). The model was externalizing its chain-of-thought as visible
chat text, which at ~50-80 tok/s burns 8-15s of the 60s budget before
submit is even queued. The previous HEADER said "solve silently" but
the model treats visible reasoning as *its work*, not narration.

- **`fdkey_get_challenge` description** trimmed and reframed: explicit
  "VERY NEXT action must be submit", "reason internally (extended
  thinking if available), not in chat". Less prose for the agent to
  parse before calling.
- **`fdkey_submit_challenge` description** leads with "VERY NEXT tool
  call after get with NO intervening visible text". Wire-format detail
  preserved (still needed for the double-wrap fix from 0.2.6).
- **Companion VPS change (same day)** — challenge HEADER shortened
  from ~95 words to ~50 and rewritten to name the failure mode: every
  token of visible analysis delays submit; reason in internal/extended
  thinking, not chat.

No SDK code-flow changes. Pure copy improvements + version bump.

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
