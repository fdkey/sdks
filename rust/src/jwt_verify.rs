//! Ed25519 JWT verification. Same wire shape as the TypeScript SDK.

use std::collections::HashMap;

use jsonwebtoken::{decode, decode_header, Algorithm, Validation};
use serde::Deserialize;

use crate::types::FdkeyError;
use crate::well_known::WellKnownClient;

const CLOCK_TOLERANCE_SECONDS: u64 = 30;

#[derive(Debug, Deserialize)]
pub struct VerifiedJwt {
    pub score: f64,
    pub tier: String,
    #[serde(default)]
    pub puzzle_summary: serde_json::Value,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

pub struct JwtVerifier {
    well_known: WellKnownClient,
}

impl JwtVerifier {
    pub fn new(well_known: WellKnownClient) -> Self {
        Self { well_known }
    }

    /// Verify a Bearer JWT and return the decoded claims. Errors on any
    /// failure — bad signature, expired (modulo 30s tolerance), unknown kid.
    pub async fn verify(&self, token: &str) -> Result<VerifiedJwt, FdkeyError> {
        let header = decode_header(token)?;
        let kid = header.kid.ok_or(FdkeyError::MissingKid)?;
        let key = self
            .well_known
            .get_key(&kid)
            .await?
            .ok_or_else(|| FdkeyError::UnknownKid(kid.clone()))?;

        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = CLOCK_TOLERANCE_SECONDS;
        // FDKEY's audience is the integrator's vps_users.id, which the
        // SDK doesn't know at verify time. Defense-in-depth: the VPS
        // already binds aud to the api_key that requested the challenge.
        validation.validate_aud = false;

        let data = decode::<serde_json::Value>(token, &key, &validation)?;
        let claims = serde_json::from_value::<VerifiedJwt>(data.claims)?;
        Ok(claims)
    }
}

/// Pull a Bearer token out of an `Authorization` header value. Returns None
/// for missing, empty, malformed, or non-`Bearer` schemes. Case-insensitive.
pub fn extract_bearer(header_value: Option<&str>) -> Option<&str> {
    let value = header_value?.trim();
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}
