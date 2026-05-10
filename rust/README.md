# fdkey

> **FDKEY verification primitives (Rust).** Gate AI-agent access to your
> tools / API behind LLM-only puzzles. Companion to the TypeScript and
> Python SDKs at <https://github.com/fdkey/sdks>.

## What this crate ships

The Rust MCP server ecosystem is still consolidating across multiple
community SDKs (`rmcp`, `mcp-server-rs`, `tower-mcp`, etc.) and there is
no single canonical Anthropic-blessed Rust MCP SDK to wrap. This crate
intentionally exposes **primitives** so you can plug FDKEY into whichever
MCP server library you use — or your plain HTTP service:

- `Verifier` — bundles `JwtVerifier` + `VpsClient`. The canonical entry point.
- `JwtVerifier` — Ed25519 JWT verify against the cached `/.well-known/fdkey.json`.
- `VpsClient` — `POST /v1/challenge` and `POST /v1/submit` to `api.fdkey.com`.
- `WellKnownClient` — `HashMap<kid, DecodingKey>` cached for 1 hour, refresh on miss.
- `guard::{can_call, mark_verified, consume_policy}` — pure per-session policy logic, identical to the TypeScript and Python SDKs.

The wire shape (challenge / submit JSON, JWT claims) matches the other
SDKs exactly — the FDKEY VPS doesn't know which language called it.

## Install

```bash
cargo add fdkey
```

Get an API key at [app.fdkey.com](https://app.fdkey.com).

## Usage — verify a Bearer JWT in any HTTP service

```rust
use fdkey::{Verifier, FdkeyConfig, jwt::extract_bearer};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = FdkeyConfig {
        api_key: std::env::var("FDKEY_API_KEY")?,
        vps_url: Some("https://api.fdkey.com".into()),
        ..Default::default()
    };
    let verifier = Verifier::new(&cfg)?;

    // Inside your HTTP handler, given an Authorization header value:
    let auth = Some("Bearer eyJ...");
    if let Some(token) = extract_bearer(auth) {
        let claims = verifier.verify_token(token).await?;
        // `score` is a 0..1 float (today effectively binary 1.0/0.0;
        //  reserved for graduated capability scoring later).
        println!("score={}, tier={}", claims.score, claims.tier);
    }
    Ok(())
}
```

## Usage — fetch + submit a challenge programmatically

```rust
use fdkey::{Verifier, FdkeyConfig};
use fdkey::vps::ChallengeMeta;

# async fn _example() -> Result<(), fdkey::FdkeyError> {
let cfg = FdkeyConfig { api_key: "fdk_...".into(), ..Default::default() };
let verifier = Verifier::new(&cfg)?;

let challenge = verifier.vps.fetch_challenge(&ChallengeMeta::default()).await?;
// hand the puzzles to your agent caller, collect their answers...
let answers = serde_json::json!({ "type1": [], "type3": {} });
let result = verifier.vps.submit_answers(&challenge.challenge_id, &answers).await?;
if result.verified {
    let jwt = result.jwt.expect("jwt on verified");
    let claims = verifier.verify_token(&jwt).await?;
    println!("score={}", claims.score);
}
# Ok(())
# }
```

## Per-session policy gating

The crate exposes the same three policy variants the TS and Python SDKs
support — pick the one that fits each tool / route:

```rust
use fdkey::Policy;

Policy::EachCall                           // verify on every invocation (irreversible actions)
Policy::OncePerSession                     // verify once per connection (signup-style flows)
Policy::EveryMinutes { minutes: 15 }       // verification valid for N minutes after solve;
                                           // does NOT extend on subsequent calls
```

Plug the per-session state machine the TS / Python SDKs use into your
MCP server's tool-call dispatch:

```rust
use fdkey::{guard::*, Policy, SessionState};

let mut session = SessionState::default();
let policy = Policy::EachCall;

// On every tool call:
if can_call(&policy, "sensitive", &session) {
    // run the tool
    consume_policy(&policy, &mut session);
} else {
    // return fdkey_verification_required
}

// When the FDKEY submit step succeeds:
mark_verified(&mut session);
```

## Configuration reference

```rust
FdkeyConfig {
    api_key: "fdk_...".into(),         // required
    vps_url: None,                      // defaults to https://api.fdkey.com
    difficulty: Difficulty::Medium,     // Easy | Medium | Hard
    on_fail: FailMode::Block,           // Block | Allow (puzzle failed)
    on_vps_error: FailMode::Allow,      // Block | Allow — see below
    protect: HashMap::new(),            // tool name -> Policy (your dispatch reads this)
    tags: None,                         // forwarded to FDKEY for analytics
}
```

### Failure-mode defaults

`on_vps_error: FailMode::Allow` is the default — if the FDKEY scoring
service is unreachable, your dispatch should fall through to the
unprotected handler rather than rejecting traffic. We chose this so an
FDKEY outage doesn't brick integrator workflows (e.g. if we shut down
the service or `api.fdkey.com` is unreachable). FDKEY is verification,
not gating — your service should still serve traffic when ours is down.
Set `on_vps_error: FailMode::Block` if you'd rather reject unverified
callers during an outage. The crate exposes this as a config field;
the actual fail-open behavior is up to your dispatch implementation
(see "Per-session policy gating" above).

## Security notes — integrator obligations

Because this crate ships **primitives** rather than a single framework
wrapper, three protections that the TypeScript and Python sibling SDKs
enforce in code are YOUR responsibility in Rust. Skipping any of them
leaves your service open to abuse the wire format already protects
against.

### 1. NEVER return the JWT to the agent

The example in "Usage — fetch + submit a challenge programmatically"
above does:

```rust
let jwt = result.jwt.expect("jwt on verified");
let claims = verifier.verify_token(&jwt).await?;
```

After that line, **the JWT is a server-side verification artifact —
discard it.** Persist `{ verified_at, score: claims.score, tier:
claims.tier }` in your session store; surface only that to the agent.
If you echo the JWT back in your HTTP response or in a tool result,
you've handed the agent a bearer token it can replay against any
other FDKEY-protected service within the JWT's lifetime
(~5 min default).

The TypeScript reference at
[`@fdkey/http`](https://www.npmjs.com/package/@fdkey/http) implements
the same flow correctly — its session-mediated design is the
canonical pattern. Mirror it.

### 2. Use UUIDs (or other non-reusable identifiers) for session keys

Don't key your session store on raw pointer addresses, `Box::into_raw`
casts, or any other identity that can be reused after a session is
dropped. CPython has the same problem (see the Python SDK's
`_SessionKeyTracker` for the parallel mitigation); in Rust the risk
is smaller (the borrow checker prevents most aliasing) but pointer
reuse is still a real foot-gun for raw-pointer-based session maps.

Generate a fresh UUID per session (`uuid::Uuid::new_v4()`) and store
the mapping in a structure that guarantees no two live sessions can
share the same key.

### 3. Bound your session store with TTL + LRU eviction

A naive `HashMap<SessionId, SessionState>` grows forever as agents
connect and drift away. On a long-lived multi-tenant server this is a
memory leak you'll only notice in production.

The TypeScript sibling ships `InMemorySessionStore` at
`mcp-integration/sdks/http/src/session-store.ts` with a 1-hour idle
TTL and a 10 000-entry hard cap. Port the pattern to Rust — sweep on
access, drop the oldest LRU entry on insert when at the cap, no
background timer needed. ~40 lines.

### 4. JWT `aud` is not validated by the SDK

The audience claim binds the JWT to the integrator's `vps_users.id`,
which the SDK doesn't know at verify time. The VPS already binds
`aud` to the API key that requested the challenge — defense in
depth — but in principle, a JWT issued for one FDKEY-protected
service could be replayed against a different one within the JWT
lifetime (~5 min default). Keep the JWT lifetime short on the VPS
side if your threat model includes cross-integrator replay.

## Links

- Marketing + docs: <https://fdkey.com>
- Dashboard (sign up + manage keys): <https://app.fdkey.com>
- Source: <https://github.com/fdkey/sdks>
- Issues: <https://github.com/fdkey/sdks/issues>

## License

MIT — see [LICENSE](./LICENSE).
