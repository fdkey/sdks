# `fdkey` (Rust SDK) — Architecture Reference

> **Purpose.** Cross-language verification primitives — same wire format and same per-session policy semantics as `@fdkey/mcp` (TypeScript) and `fdkey` (Python). The Rust MCP server ecosystem has multiple competing SDKs (`rmcp`, `mcp-server-rs`, `tower-mcp`) and no canonical Anthropic-blessed one, so this crate ships **primitives** rather than wrapping a single framework.
>
> **Last verified against:** `src/` as of 2026-05-09 (initial 0.1.0 release).

---

## § 1 — Top-level

What the crate ships:

- `Verifier` — the entry point. Bundles `JwtVerifier` + `VpsClient`.
- `JwtVerifier` — Ed25519 JWT verify against a cached well-known.
- `VpsClient` — `POST /v1/challenge`, `POST /v1/submit`. `client_type` is selectable so the same crate can serve MCP integrators (`"mcp"`) or REST integrators (`"rest"`).
- `WellKnownClient` — `HashMap<kid, DecodingKey>` cached for 1 hour, refreshes on cache-miss for a kid (mid-rotation).
- `guard::{can_call, mark_verified, consume_policy}` — pure per-session policy logic; identical state machine to TS / Python.
- Types: `FdkeyConfig`, `Policy`, `FdkeyContext`, `SessionState`, `VerifiedClaims`, `FdkeyError`.

What the crate does NOT ship: a single MCP-server adapter. The Rust MCP ecosystem is fragmented; integrators plug `Verifier` + `guard` into whichever server framework they use. The wire format, JWT shape, and policy semantics match the TS / Python SDKs exactly — any FDKEY-issued JWT verifies identically across languages.

---

## § 2 — Directory map

```
mcp-integration/sdks/rust/
├─ src/
│  ├─ lib.rs            — Public crate root. Re-exports + `Verifier` constructor
│  │                       (`new` for REST clients, `new_mcp` for MCP).
│  ├─ types.rs          — FdkeyConfig, Policy, SessionState, FdkeyContext,
│  │                       VerifiedClaims, FdkeyError. Plus Difficulty + FailMode enums.
│  ├─ guard.rs          — Pure policy evaluation. Mirrors guard.ts / guard.py
│  │                       byte-for-byte (modulo language).
│  ├─ jwt_verify.rs     — JwtVerifier + extract_bearer header parser.
│  │                       Uses jsonwebtoken's EdDSA support + 30s clock tolerance.
│  ├─ vps_client.rs     — reqwest-based async client. POST /v1/challenge,
│  │                       POST /v1/submit. ChallengeMeta forwarded as the
│  │                       same agent / integrator / tags blocks the TS SDK uses.
│  └─ well_known.rs     — HashMap<kid, DecodingKey> cache, 1h TTL, refresh-on-miss.
├─ tests/
│  └─ integration.rs    — wiremock-backed end-to-end: well-known spoof +
│                           Ed25519 sign-verify round-trip + extract_bearer +
│                           guard semantics for each policy variant.
├─ Cargo.toml           — name `fdkey`, version 0.1.0. Dependencies:
│                           reqwest (rustls-tls only — no native-tls dep),
│                           jsonwebtoken, tokio (sync + time + macros),
│                           serde + serde_json, thiserror.
├─ LICENSE              — MIT.
├─ README.md            — Install + usage examples (HTTP backend, fetch+submit,
│                           per-session policy gating, config reference).
└─ ARCHITECTURE.md      — This file.
```

---

## § 3 — Per-file detail

### `src/lib.rs`

**Purpose.** Crate entry point. Re-exports public API. Defines `Verifier` — the bundle most users want.

**Public exports.**
- `Verifier`, `Verifier::new(config) -> Result<Self>`, `Verifier::new_mcp(config)`.
- Module aliases `jwt::*` and `vps::*` for friendlier re-exports.
- Direct re-exports of all public types from `types.rs`.

**Default VPS URL** is `https://api.fdkey.com` — used when `FdkeyConfig.vps_url` is `None`.

---

### `src/types.rs`

`Policy` is a Rust enum (`OncePerSession`, `EachCall`, `EveryMinutes { minutes: u32 }`) — direct translation of the TS discriminated union. `FdkeyConfig` is `Default`-derived so callers can use `..Default::default()` to avoid spelling out every field. `FdkeyError` is `thiserror`-derived and covers the four failure modes: HTTP, JSON, JWT, and VPS-status-non-2xx.

The `FdkeyContext` struct is what an integrator-side handler reads. **`score: Option<f64>` and `tier: Option<String>` are first-class fields** for forward-compat with future capability scoring (today the value is binary 1.0 / 0.0).

---

### `src/guard.rs`

Pure functions over `&SessionState` / `&mut SessionState`. No I/O. The state machine (verified, fresh_verification_available, verified_at_ms) matches the TS and Python SDKs byte-for-byte. `now_ms()` reads `SystemTime::now()` once per call.

---

### `src/jwt_verify.rs`

`JwtVerifier::verify(token)` — `decode_header` → kid → `WellKnownClient.get_key(kid)` → `jsonwebtoken::decode` with `Validation::new(Algorithm::EdDSA)` and 30s leeway → returns `VerifiedJwt` (struct deserialized from claims). `validate_aud` is **disabled** because the SDK doesn't know the integrator's `vps_users.id` at verify time; the VPS already binds aud to the api_key that requested the challenge (defense in depth).

`extract_bearer(Option<&str>) -> Option<&str>` — case-insensitive parser for `Authorization` header values. Returns `None` on missing, empty, malformed, or non-Bearer values.

---

### `src/vps_client.rs`

`VpsClient` wraps a `reqwest::Client` (10s timeout, rustls-tls) bound to the integrator's API key. `fetch_challenge(meta)` POSTs `/v1/challenge` with the same body shape the TS SDK sends:

```json
{
  "difficulty": "medium",
  "client_type": "mcp" | "rest",
  "agent": { ... },         // optional, only included if populated
  "integrator": { ... },    // optional
  "tags": { ... }           // optional
}
```

`submit_answers(challenge_id, answers)` POSTs `/v1/submit`. Both methods return decoded `ChallengeResponse` / `SubmitResponse` structs.

**Errors.** Non-2xx VPS responses surface as `FdkeyError::VpsHttp { status, body }`. Network failures bubble up as `FdkeyError::Http`. Decode errors as `FdkeyError::Json`.

---

### `src/well_known.rs`

`WellKnownClient` holds an `Arc<Mutex<CacheState>>` where `CacheState` is `HashMap<kid, DecodingKey>` + `Option<Instant>` for TTL tracking. On cache miss, calls `_refresh()` once before returning. The lock is held only across the cache read + the refresh call — concurrent calls coalesce safely.

Ed25519 PEM keys are imported via `DecodingKey::from_ed_pem` (jsonwebtoken 9.3+).

---

## § 4 — Build requirements

### Toolchain

- **Rust 1.75+** (edition 2021, async fn in trait stable).
- **Windows-MSVC builds** require Visual Studio 2019 Build Tools or later (provides `link.exe`). On a fresh Windows machine without these installed, `cargo build` will fail at the link step with "link.exe not found" or — more confusingly — a GNU coreutils `link: extra operand` error if Git for Windows' `link` shadows the missing MSVC linker.
  - Fix: install Visual Studio Build Tools with the "Desktop development with C++" workload, OR switch to the GNU toolchain via `rustup default stable-x86_64-pc-windows-gnu`.
- **Linux / macOS / WSL**: works with the system C toolchain, no extra setup.

### Running tests

```bash
cargo test          # full integration tests (wiremock-backed)
cargo test --lib    # just unit tests
cargo build         # release build → target/release/libfdkey.rlib
cargo publish --dry-run    # validates package shape pre-publish
```

The integration tests in `tests/integration.rs` spin up a wiremock server, generate a one-shot Ed25519 keypair via `ed25519-dalek`, and round-trip a JWT through `Verifier::verify_token`. Tests touch the FDKEY VPS only via the wiremock — no network egress, no real api.fdkey.com calls.

---

## § 5 — Integrator obligations (security-relevant)

The TypeScript and Python sibling SDKs each enforce three protections in code that the Rust crate **does NOT enforce** because it ships primitives only. Integrators are responsible for honoring them. The README says this in user-facing terms; this section captures the rationale and the mitigation patterns for future maintainers.

### Obligation 1 — JWT must NOT reach the agent

The flow is:

```
agent → integrator's MCP server (or HTTP route)
         ↓ (server-to-server, integrator's API key)
       api.fdkey.com /v1/submit  →  { verified: true, jwt }
         ↓
       JwtVerifier::verify(&jwt) → VerifiedJwt { score, tier, claims }
         ↓
       integrator persists { verified_at, score, tier } in their session
         ↓
       agent gets back: { verified: true, score, tier }   ← no JWT
```

If the integrator echoes the JWT to the agent (in a tool result body, an HTTP response, etc.), the agent now holds a bearer token that can be replayed against any other FDKEY-protected service within the JWT's lifetime (~5 min default). The crate cannot enforce this — `verifier.verify_token(&jwt)` is a pure function, and what the integrator does with the JWT after that call is opaque to us.

The TS reference at `mcp-integration/sdks/http/src/index.ts` (search for `processSubmit`) shows the canonical session-mediated implementation. Rust integrators should mirror the same shape.

### Obligation 2 — Stable, non-reusable session keys

A session map keyed on `*const SessionState`, `Box::into_raw` casts, or any other identity that can be reused after a session is dropped is unsafe. After the original session is gone, a new allocation can land on the same address; any state still cached under that pointer-as-key gets resurrected for the wrong tenant.

The Python sibling solves this with `_SessionKeyTracker` — a `WeakKeyDictionary[ServerSession, UUID]` that maps each live session to a fresh UUID and uses a `weakref.finalize` to evict the store entry the moment the session is gc'd. In Rust the borrow checker prevents most aliasing, but raw-pointer-keyed maps are still possible — and still wrong.

Recommended Rust pattern:

```rust
use uuid::Uuid;
use std::collections::HashMap;

struct SessionRegistry {
    sessions: HashMap<Uuid, SessionState>,
    // ... TTL + LRU; see Obligation 3
}

impl SessionRegistry {
    fn key_for_new_session() -> Uuid {
        Uuid::new_v4()
    }
}
```

The Uuid is monotonically unique per process. No reuse, no aliasing.

### Obligation 3 — Bounded session storage

A naive `HashMap<Uuid, SessionState>` grows forever as agents connect and drift away. The TS reference (`mcp-integration/sdks/http/src/session-store.ts`) ships an `InMemorySessionStore` with:

- **TTL** (1-hour idle): when a new session is inserted, sweep the head of the LRU map; if its `lastTouchedAt` is older than `idleTtlMs`, drop it. O(1) per insert.
- **Hard cap** (10 000 entries): when the map is at `maxSize`, force-evict the LRU head before insert. O(1) thanks to the JS Map's preserved-insertion-order; Rust's `LinkedHashMap` (or a `(VecDeque<Uuid>, HashMap<Uuid, _>)` pair) gives the same.

The crate doesn't ship this in Rust because every integrator has a different context (in-process vs Redis-backed vs Durable Objects). But every integrator needs SOMETHING here — an unbounded map IS a leak.

### Why the crate doesn't enforce these in code

Rust's MCP ecosystem is fragmented: `rmcp`, `mcp-server-rs`, `tower-mcp`, hand-rolled bytestream servers — each has a different framework shape, lifecycle model, and concurrency story. Wrapping any one of them in the crate would force the crate to track that framework's release cadence and create a permanent maintenance burden. Shipping primitives keeps the crate small (~500 LOC) and lets integrators bolt FDKEY onto whatever they're already running.

The trade-off is exactly the obligation list above. Future-you reading this in 2027 should understand that `@fdkey/http` is the canonical implementation; this crate provides the verified-correct primitives to build a Rust equivalent.

---

## § 6 — Wire-format compatibility with the other SDKs

**This is the rule:** every byte FDKEY's VPS sees from this crate must match what the TS SDK sends. If a TS SDK release changes the challenge body, the Rust SDK gets the same change in the same release — coordinated via [../typescript/ARCHITECTURE.md § 6 wire format](../typescript/ARCHITECTURE.md#-6--public-api-surface).

Currently aligned:
- `POST /v1/challenge` body: `{ difficulty, client_type, agent?, integrator?, tags? }`.
- `POST /v1/submit` body: `{ challenge_id, answers }`.
- JWT header: `{ alg: "EdDSA", kid: "..." }`.
- JWT payload: `{ sub, aud, iss, iat, nbf, exp, score, threshold, tier, puzzle_summary, ... }`.
- `/.well-known/fdkey.json` shape: `{ issuer, keys: [{ alg, kid, public_key_pem }], jwt_default_lifetime_seconds }`.

If the VPS adds a field, the Rust crate's `VerifiedClaims.extra: HashMap<String, Value>` catches it without a code change.

---

## § 7 — Maintenance protocol

> **Rule:** when you change `src/**` or `Cargo.toml`'s public surface, update this file.

Common changes:
- New field on `VerifiedClaims`? → `types.rs` + the corresponding TS / Python `FdkeyContext` for cross-language parity. README config table.
- New `Policy` variant? → `types.rs` + `guard.rs` (pattern match exhaustive). Same change in TS + Python guards.
- New `client_type` value? → `lib.rs` `Verifier::with_client_type`. Coordinate with `vps/src/routes/v1/challenge.ts:26` — the VPS-side zod enum is the source of truth.
- Bumped version? → `Cargo.toml` only. No code-side version constant in this crate.
