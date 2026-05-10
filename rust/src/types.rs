//! Public types: config, policies, session state, verification context.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Per-tool gating policy. Mirrors the TypeScript SDK's `Policy` discriminated
/// union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Policy {
    /// Pass forever once the session has been verified at least once.
    OncePerSession,
    /// Pass only when there is an unconsumed fresh-verification ticket; the
    /// ticket is consumed on each gated tool call.
    EachCall,
    /// Pass while `now - verified_at < minutes` minutes. The clock does NOT
    /// extend on calls; it expires `minutes` minutes after the puzzle was solved.
    EveryMinutes { minutes: u32 },
}

/// Configuration passed once to `with_fdkey()` (or constructed manually for
/// integrator-flexible wiring).
#[derive(Debug, Clone)]
pub struct FdkeyConfig {
    pub api_key: String,
    pub vps_url: Option<String>,
    pub difficulty: Difficulty,
    pub on_fail: FailMode,
    pub on_vps_error: FailMode,
    pub protect: HashMap<String, Policy>,
    pub tags: Option<HashMap<String, String>>,
}

impl Default for FdkeyConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            vps_url: None,
            difficulty: Difficulty::Medium,
            on_fail: FailMode::Block,
            on_vps_error: FailMode::Allow,
            protect: HashMap::new(),
            tags: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailMode {
    /// Refuse the call (HTTP 503 / tool-error / etc.). Default.
    Block,
    /// Let the call through unverified — useful for soft launches.
    Allow,
}

/// Per-session mutable state. Mirrors `SessionState` in the TS SDK.
#[derive(Debug, Default, Clone)]
pub struct SessionState {
    pub verified: bool,
    pub verified_at_ms: Option<i64>,
    pub fresh_verification_available: bool,
    pub pending_challenge_id: Option<String>,
    pub last_claims: Option<serde_json::Value>,
}

/// Read-only context surfaced to integrator handlers. `score` and `tier`
/// are first-class fields — today they are effectively binary (1.0 = passed,
/// 0.0 = failed), but the wire shape reserves the float for forward-compat
/// capability scoring without an API change.
#[derive(Debug, Clone, PartialEq)]
pub struct FdkeyContext {
    pub verified: bool,
    pub verified_at_ms: Option<i64>,
    pub score: Option<f64>,
    pub tier: Option<String>,
    pub claims: Option<serde_json::Value>,
}

/// Decoded result of a successful submit — the JWT claims FDKEY issued.
#[derive(Debug, Clone, Deserialize)]
pub struct VerifiedClaims {
    pub score: f64,
    pub threshold: Option<f64>,
    pub tier: String,
    #[serde(default)]
    pub puzzle_summary: serde_json::Value,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Errors surfaced from the SDK's HTTP and crypto paths.
#[derive(Debug, thiserror::Error)]
pub enum FdkeyError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("VPS returned {status}: {body}")]
    VpsHttp { status: u16, body: String },
    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("JWT verification failed: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    #[error("Verification refused (no kid header on JWT)")]
    MissingKid,
    #[error("Verification refused (kid {0} not in well-known)")]
    UnknownKid(String),
    #[error("Verification refused (challenge expired)")]
    ChallengeExpired,
    #[error("{0}")]
    Other(String),
}
