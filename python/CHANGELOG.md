# Changelog

All notable changes to `fdkey` (Python, PyPI) will be documented
in this file.

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
