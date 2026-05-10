//! HTTP client for `api.fdkey.com` — fetch challenge, submit answers.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::types::{Difficulty, FdkeyError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
struct ChallengeBody<'a> {
    difficulty: Difficulty,
    client_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    integrator: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<&'a HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChallengeResponse {
    pub challenge_id: String,
    pub expires_at: String,
    #[serde(default)]
    pub expires_in_seconds: Option<u64>,
    pub difficulty: String,
    #[serde(default)]
    pub types_served: Vec<String>,
    pub puzzles: serde_json::Value,
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub footer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubmitResponse {
    pub verified: bool,
    #[serde(default)]
    pub jwt: Option<String>,
    #[serde(default)]
    pub types_passed: Option<u32>,
    #[serde(default)]
    pub types_served: Option<u32>,
    #[serde(default)]
    pub required_to_pass: Option<u32>,
    #[serde(default)]
    pub breakdown: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct SubmitBody<'a> {
    challenge_id: &'a str,
    answers: &'a serde_json::Value,
}

/// Per-call metadata bundle. Mirrors `ChallengeMeta` in the TS SDK.
#[derive(Default, Debug, Clone)]
pub struct ChallengeMeta {
    pub agent: Option<serde_json::Value>,
    pub integrator: Option<serde_json::Value>,
    pub tags: Option<HashMap<String, String>>,
}

#[derive(Clone)]
pub struct VpsClient {
    vps_url: String,
    api_key: String,
    difficulty: Difficulty,
    client_type: &'static str,
    inner: reqwest::Client,
}

impl VpsClient {
    /// `client_type` should be `"mcp"` for the MCP SDK path or `"rest"` for
    /// generic HTTP integrations.
    pub fn new(
        vps_url: impl Into<String>,
        api_key: impl Into<String>,
        difficulty: Difficulty,
        client_type: &'static str,
    ) -> Result<Self, FdkeyError> {
        let inner = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build()?;
        Ok(Self {
            vps_url: vps_url.into(),
            api_key: api_key.into(),
            difficulty,
            client_type,
            inner,
        })
    }

    pub async fn fetch_challenge(
        &self,
        meta: &ChallengeMeta,
    ) -> Result<ChallengeResponse, FdkeyError> {
        let body = ChallengeBody {
            difficulty: self.difficulty,
            client_type: self.client_type,
            agent: meta.agent.as_ref(),
            integrator: meta.integrator.as_ref(),
            tags: meta.tags.as_ref(),
        };
        self.post_json("/v1/challenge", &body).await
    }

    pub async fn submit_answers(
        &self,
        challenge_id: &str,
        answers: &serde_json::Value,
    ) -> Result<SubmitResponse, FdkeyError> {
        let body = SubmitBody { challenge_id, answers };
        self.post_json("/v1/submit", &body).await
    }

    async fn post_json<B: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<R, FdkeyError> {
        let url = format!("{}{}", self.vps_url, path);
        let res = self
            .inner
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(body)
            .send()
            .await?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(FdkeyError::VpsHttp {
                status: status.as_u16(),
                body: text,
            });
        }
        let parsed = serde_json::from_str(&text)?;
        Ok(parsed)
    }
}
