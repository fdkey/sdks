# Changelog

All notable changes to `fdkey` (Python, PyPI) will be documented
in this file.

## 0.2.1 — 2026-05-11

### Changed — review follow-up to 0.2.0

Code-review polish on the 0.2.0 release. No behavior change for
integrators; correctness and robustness improvements only.

- **Annotation detection via `inspect.signature`** instead of
  `try/except TypeError`. The previous fallback would silently swallow
  unrelated `TypeError`s (bad handler signature, duplicate name, etc.)
  and re-register the tool without annotations. The new helper
  `_supports_kwarg(fn, 'annotations')` inspects the callable's
  signature at registration time and only includes the keyword when
  it's actually accepted. No retries; no exception sentinel.
- **Handlers built once.** `_make_get_challenge_handler(state)` and
  `_make_submit_handler(state)` are now called exactly once per
  registration instead of potentially twice on the old fallback path.

### Added — tests

- `test_challenge_text_returns_mcp_response_text_verbatim_when_present`
  — confirms the canonical 0.2.0 passthrough path.
- `test_challenge_text_falls_back_to_json_when_mcp_response_text_absent`
  — confirms the puzzle-agnostic JSON fallback (header + puzzles +
  example_submission + footer).
- `test_challenge_text_falls_back_when_mcp_response_text_is_empty_string`
  — empty string treated as "not provided"; agent gets the fallback
  instead of an empty result.
- `test_tools_are_registered_with_stable_mcp_annotations` — both
  injected tools carry `ToolAnnotations(title, readOnlyHint=False,
  destructiveHint=False, idempotentHint=False, openWorldHint=True)`.
- `test_supports_kwarg_introspection` — covers the new signature-
  inspection helper, including graceful False on unintrospectable
  callables.

### Docs

- README now references the `mcp_response_text` field by name so
  Python integrators searching for the wire-format contract can find
  it without diving into CHANGELOG / ARCHITECTURE.

## 0.2.0 — 2026-05-11

### Changed — parity with @fdkey/mcp 0.3.1 (TypeScript)

Two parallel changes that bring the Python SDK in line with the TS
SDK's recent direction. The SDK stays puzzle-agnostic; all agent-
facing prose (puzzles, instructions, examples, timing framing) lives
on the VPS, not in the SDK.

- **`mcp_response_text` passthrough.** When the VPS supplies a pre-
  rendered directive in `ChallengeResponse.mcp_response_text` (VPS
  2026-05-11+, sent for `client_type='mcp'`), `fdkey_get_challenge`
  returns it verbatim as the tool result. The `inlineChallenge`
  path uses the same renderer for consistency. When the VPS doesn't
  supply it (older VPS), the SDK falls back to the prior JSON dict
  payload (now also including `example_submission`). Result: agents
  receive a single directive-shaped string from the VPS instead of
  a JSON dump the model would have to narrate.

- **Stable MCP tool annotations.** Both injected tools now carry the
  formal MCP `annotations` block: `title`, `readOnlyHint=False`,
  `destructiveHint=False`, `idempotentHint=False`, `openWorldHint=True`.
  Honest (we modify server state; we don't destroy data; each call is
  independent; we talk to an external service). Values are stable
  across puzzle types / timing config — they describe protocol-level
  behavior, not what the tool serves, so puzzle iteration won't churn
  the client-side trust fingerprint.

Compatibility: annotations are passed via `FastMCP.add_tool(...,
annotations=ToolAnnotations(...))` when the keyword exists. Older
FastMCP releases lacking the keyword fall back transparently to a
no-annotations registration — no integrator-facing break.

### Added

- `ChallengeResponse.mcp_response_text: Optional[str]` (passthrough
  from VPS).
- `ChallengeResponse.example_submission: Optional[dict]` (passthrough;
  shape varies by `client_type`).

### Migration

No integrator-facing API changes. Bump the dep and redeploy.

## 0.1.1 — 2026-05-10

### Changed — behavior

- **`on_fail="allow"` no longer masks integrator/SDK bugs.** The
  SDK now distinguishes agent-facing 4xx (`challenge_expired`,
  `already_submitted`, `wrong_user`, `invalid_challenge`,
  `challenge_not_found`) from client-bug 4xx (`invalid_body`, 422,
  etc.). Agent-facing 4xx still routes through `on_fail` as
  "verification failure" semantics. Client-bug 4xx now always
  surfaces as `fdkey_unexpected_4xx` regardless of `on_fail` — a
  malformed submit body is not the same as the agent failing the
  puzzle.
- `on_vps_error="allow"` semantics unchanged — it has always fired
  only on 5xx + network errors here.
- The companion `vps/src/routes/v1/submit.ts` Zod schema was
  loosened on the same day so client-bug 4xx is rare in practice —
  empty/garbage answers are now scored to `verified: False` rather
  than rejected with 400.

## 0.1.0 — 2026-05-09

Initial public release. MCP middleware for FastMCP. Session-mediated
flow — agent never holds a JWT. Thread-safe session store
(WeakKeyDictionary + threading.RLock), 1 h idle TTL + 10 k LRU cap.
