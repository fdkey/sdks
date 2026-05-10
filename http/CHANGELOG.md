# Changelog

All notable changes to `@fdkey/http` will be documented in this file.

## 0.1.2 — 2026-05-10

### Changed — behavior

- **`onVpsError` fail-open narrowed to true outages.** The SDK no
  longer fail-opens on VPS 4xx responses (`invalid_body`, 422, 404,
  etc.). Per the README contract — "If the FDKEY scoring service is
  unreachable, the SDKs default to fail-open" — only network errors
  and 5xx responses count as "unreachable". 4xx means the VPS is
  working and your request is malformed; the SDK now always returns
  503 with `error: 'fdkey_unexpected_4xx'` for these, regardless of
  `onVpsError`.
- Pre-0.1.2 behavior leaked fake-pass verdicts when the SDK sent a
  malformed body — the VPS rejected with 400, the SDK saw a 4xx
  it didn't recognize, and `onVpsError: 'allow'` synthesized a
  verified-but-`score:0` session. This was the exact opposite of
  the documented intent and could let a buggy integrator silently
  admit unverified traffic. Existing 401/403 handling (always loud,
  bad API key) and agent-facing 4xx handling (`challenge_expired`
  → `verified: false`) are unchanged.
- The companion `vps/src/routes/v1/submit.ts` Zod schema was
  loosened on the same day so the VPS rarely returns 4xx for
  empty/garbage answers anymore — they're scored as `verified:
  false` instead. So this code path mostly fires for genuine
  protocol violations now.

### Tests

- New regression test: VPS 400 `invalid_body` → SDK 503
  `fdkey_unexpected_4xx`, no synthetic session minted, even with
  `onVpsError: 'allow'`.

## 0.1.1 — 2026-05-10

### Documentation

- README now correctly states `onVpsError` defaults to `'allow'`
  (fail-open). The 0.1.0 README incorrectly claimed `'block'` was the
  default, which would have led integrators to design fail-closed
  handlers based on a mismatched assumption. Code behavior unchanged
  — the default has always been `'allow'`.
- "If you want strict consistency" paragraph clarified for the
  `onVpsError: 'block'` path: middleware returns 503 AND `/fdkey/submit`
  returns 503, so handlers never see a synthetic session.

No code changes. Republishing to align registry README with the
actual code behavior.

## 0.1.0 — 2026-05-09

Initial public release. Plain-HTTP middleware for Express, Fastify,
and Hono. Session-mediated flow — agent never holds a JWT.
