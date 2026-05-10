# Changelog

All notable changes to the `fdkey` crate (Rust, crates.io) will be
documented in this file.

## 0.1.1 — 2026-05-10

### Documentation

- Bumped for parity with the other three SDKs (`@fdkey/mcp@0.2.2`,
  `@fdkey/http@0.1.2`, `fdkey@0.1.1` on PyPI) — those tightened
  fail-open semantics so 4xx from the VPS never silently passes
  as a verified session. The Rust crate is primitives-only and
  doesn't ship a built-in submit-error dispatcher, so the
  contract is on the integrator: only fail-open on
  `FdkeyError::Http(_)` or VPS 5xx. Treat 4xx (other than
  challenge_expired / already_submitted / wrong_user) as a
  client-side bug, never as an outage. A future minor version
  may ship a `classify_error()` helper that encodes this
  contract; for now it's by convention.

No code changes; no `Cargo.lock` differences expected. Reflects
the architectural alignment in this release window.

## 0.1.0 — 2026-05-09

Initial public release. Verification primitives: `Verifier`,
`JwtVerifier`, `WellKnownClient`, `VpsClient`, `guard` module.
Wire-compatible with the TypeScript and Python SDKs.
