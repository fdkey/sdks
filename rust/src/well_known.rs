//! `${vps_base}/.well-known/fdkey.json` cache. Mirrors the TS SDK's
//! `well-known.ts` — `HashMap<kid, DecodingKey>` cached for 1 hour,
//! refreshes on unknown kid (mid-rotation handling).
//!
//! Concurrency model: a `tokio::sync::RwLock` for the cache state plus a
//! separate `Mutex<()>` to serialize refreshes. When N concurrent callers
//! arrive on a cold cache, exactly ONE actually fetches; the others wait
//! on the refresh-mutex and read the freshly-populated cache when it
//! releases. No duplicate network calls, no races where one fetch
//! overwrites a newer one.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::DecodingKey;
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::types::FdkeyError;

const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct WellKnownPayload {
    keys: Vec<WellKnownKey>,
}

#[derive(Deserialize)]
struct WellKnownKey {
    alg: String,
    kid: String,
    public_key_pem: String,
}

#[derive(Clone)]
pub struct WellKnownClient {
    vps_base: String,
    cache: Arc<RwLock<CacheState>>,
    refresh_lock: Arc<Mutex<()>>,
    /// Single reqwest::Client shared across refreshes. Reusing the client
    /// keeps the underlying connection pool warm — relevant when the
    /// server runs through a TTL-driven refresh storm shortly after
    /// startup. Building a fresh Client per call would discard the pool
    /// and pay a TLS handshake every time.
    http: reqwest::Client,
}

struct CacheState {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Option<Instant>,
}

impl WellKnownClient {
    /// Build a new well-known client. Fallible because `reqwest::Client::
    /// builder().build()` can fail in stripped-down container images
    /// (missing CA bundle, locked-down rustls feature combos, etc.).
    /// With our default `rustls-tls` configuration it's infallible in
    /// practice, but we propagate the error rather than panicking so an
    /// integrator running in a non-standard environment gets a clean
    /// `FdkeyError` instead of a panic at startup.
    pub fn new(vps_base: impl Into<String>) -> Result<Self, FdkeyError> {
        let http = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()?;
        Ok(Self {
            vps_base: vps_base.into(),
            cache: Arc::new(RwLock::new(CacheState {
                keys: HashMap::new(),
                fetched_at: None,
            })),
            refresh_lock: Arc::new(Mutex::new(())),
            http,
        })
    }

    /// Returns a clone of the matching `DecodingKey` (or None if the kid
    /// isn't in the well-known). Triggers a refresh on cache miss / expiry.
    /// Concurrent callers coalesce on a single refresh — the second one
    /// through the refresh-lock sees the freshly-populated cache and skips
    /// the fetch.
    pub async fn get_key(&self, kid: &str) -> Result<Option<DecodingKey>, FdkeyError> {
        if let Some(key) = self.try_read_cache(kid).await {
            return Ok(Some(key));
        }
        // Cache miss / expiry. Take the refresh-lock to serialize.
        let _refresh = self.refresh_lock.lock().await;
        // Re-check: another task may have just refreshed while we waited.
        if let Some(key) = self.try_read_cache(kid).await {
            return Ok(Some(key));
        }
        self.refresh().await?;
        let cache = self.cache.read().await;
        Ok(cache.keys.get(kid).cloned())
    }

    async fn try_read_cache(&self, kid: &str) -> Option<DecodingKey> {
        let cache = self.cache.read().await;
        let fetched_at = cache.fetched_at?;
        if fetched_at.elapsed() >= CACHE_TTL {
            return None;
        }
        cache.keys.get(kid).cloned()
    }

    async fn refresh(&self) -> Result<(), FdkeyError> {
        let url = format!("{}/.well-known/fdkey.json", self.vps_base);
        let res = self.http.get(&url).send().await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(FdkeyError::VpsHttp { status, body });
        }
        let payload: WellKnownPayload = res.json().await?;
        let mut keys = HashMap::new();
        for k in payload.keys {
            // FDKEY only issues EdDSA today; pinning is enforced in jwt_verify.
            let _ = k.alg;
            match DecodingKey::from_ed_pem(k.public_key_pem.as_bytes()) {
                Ok(key) => {
                    keys.insert(k.kid, key);
                }
                Err(err) => {
                    return Err(FdkeyError::Other(format!(
                        "fdkey: failed to import key {}: {err}",
                        k.kid
                    )));
                }
            }
        }
        let mut cache = self.cache.write().await;
        cache.keys = keys;
        cache.fetched_at = Some(Instant::now());
        Ok(())
    }
}
