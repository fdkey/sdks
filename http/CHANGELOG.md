# Changelog

All notable changes to `@fdkey/http` will be documented in this file.

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
