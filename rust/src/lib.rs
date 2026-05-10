//! # FDKEY — verification primitives for MCP servers and HTTP backends.
//!
//! This crate ships the cross-language FDKEY verification logic — JWT
//! verify against the well-known endpoint, challenge fetch / submit against
//! `api.fdkey.com`, and the same per-session policy semantics as the
//! TypeScript and Python SDKs.
//!
//! The Rust MCP server ecosystem is still consolidating, so this crate
//! intentionally exposes **primitives** rather than wrapping a single
//! framework: take [`Verifier`] and [`VpsClient`], plug them into whichever
//! MCP server library you use (or your own HTTP service), and gate tool
//! calls on the policies in [`guard`].
//!
//! ## Quick start (HTTP backend)
//!
//! ```no_run
//! use fdkey::{Verifier, FdkeyConfig, jwt::extract_bearer};
//!
//! # async fn _example() -> Result<(), fdkey::FdkeyError> {
//! let cfg = FdkeyConfig {
//!     api_key: "fdk_...".into(),
//!     vps_url: Some("https://api.fdkey.com".into()),
//!     ..Default::default()
//! };
//! let verifier = Verifier::new(&cfg)?;
//!
//! // Inside your HTTP handler:
//! let auth_header: Option<&str> = Some("Bearer eyJ...");
//! if let Some(token) = extract_bearer(auth_header) {
//!     let claims = verifier.verify_token(token).await?;
//!     println!("score={}, tier={}", claims.score, claims.tier);
//! }
//! # Ok(())
//! # }
//! ```
//!
//! ## Per-session policy gating (any MCP server flavor)
//!
//! See the [`guard`] module: `can_call`, `mark_verified`, `consume_policy`,
//! and the [`SessionState`](types::SessionState) / [`Policy`](types::Policy)
//! types are the same primitives the TypeScript SDK uses.

#![deny(rust_2018_idioms)]

pub mod guard;
pub mod jwt_verify;
pub mod types;
pub mod vps_client;
pub mod well_known;

/// Re-export under a friendlier `jwt` alias for the documented quick-start.
pub mod jwt {
    pub use crate::jwt_verify::{extract_bearer, JwtVerifier, VerifiedJwt};
}
/// Re-export under a friendlier `vps` alias.
pub mod vps {
    pub use crate::vps_client::{ChallengeMeta, ChallengeResponse, SubmitResponse, VpsClient};
}

pub use jwt_verify::JwtVerifier;
pub use types::{
    Difficulty, FailMode, FdkeyConfig, FdkeyContext, FdkeyError, Policy,
    SessionState, VerifiedClaims,
};
pub use vps_client::{ChallengeMeta, ChallengeResponse, SubmitResponse, VpsClient};
pub use well_known::WellKnownClient;

/// One-shot bundle: well-known cache + JWT verifier + VPS client. The
/// canonical entry point for HTTP and custom-MCP integrations.
pub struct Verifier {
    /// JWT verifier reused across calls.
    pub jwt: JwtVerifier,
    /// HTTP client for fetching / submitting challenges.
    pub vps: VpsClient,
}

impl Verifier {
    /// Build a Verifier from a [`FdkeyConfig`]. `client_type: "rest"` —
    /// for MCP integrations call [`Verifier::new_mcp`] instead.
    pub fn new(config: &FdkeyConfig) -> Result<Self, FdkeyError> {
        Self::with_client_type(config, "rest")
    }

    /// Same as [`Verifier::new`] but tags challenge requests with
    /// `client_type: "mcp"`.
    pub fn new_mcp(config: &FdkeyConfig) -> Result<Self, FdkeyError> {
        Self::with_client_type(config, "mcp")
    }

    fn with_client_type(
        config: &FdkeyConfig,
        client_type: &'static str,
    ) -> Result<Self, FdkeyError> {
        let vps_url = config
            .vps_url
            .clone()
            .unwrap_or_else(|| "https://api.fdkey.com".to_string());
        let well_known = WellKnownClient::new(&vps_url)?;
        let jwt = JwtVerifier::new(well_known);
        let vps = VpsClient::new(
            vps_url,
            config.api_key.clone(),
            config.difficulty,
            client_type,
        )?;
        Ok(Self { jwt, vps })
    }

    /// Convenience: verify a Bearer JWT and return the (forward-compat)
    /// score and tier directly. Returns `None` on any failure.
    pub async fn verify_token(&self, token: &str) -> Result<jwt::VerifiedJwt, FdkeyError> {
        self.jwt.verify(token).await
    }
}
