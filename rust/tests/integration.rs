//! Integration tests for the FDKEY Rust SDK.
//!
//! Spins up a wiremock server that mimics the FDKEY VPS — the well-known
//! endpoint returns a freshly-generated Ed25519 public key and the SDK
//! verifies a JWT we sign with the matching private key.

use std::time::{SystemTime, UNIX_EPOCH};

use ed25519_dalek::{pkcs8::EncodePublicKey, SigningKey};
use pkcs8::LineEnding;
use fdkey::{
    guard::{can_call, consume_policy, mark_verified},
    jwt::extract_bearer,
    FdkeyConfig, Policy, SessionState, Verifier, WellKnownClient,
};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    sub: &'a str,
    aud: &'a str,
    iat: u64,
    nbf: u64,
    exp: u64,
    score: f64,
    tier: &'a str,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn ed25519_pem_pair() -> (SigningKey, String, Vec<u8>) {
    use rand_core::OsRng;
    let signing = SigningKey::generate(&mut OsRng);
    let pub_pem = signing
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .expect("encode pub PEM");
    // jsonwebtoken's EncodingKey::from_ed_pem wants a PKCS8-encoded private
    // key in PEM. Build that manually via pkcs8 v0.10 API.
    use ed25519_dalek::pkcs8::EncodePrivateKey;
    let priv_pem = signing
        .to_pkcs8_pem(LineEnding::LF)
        .expect("encode priv PEM");
    let priv_pem_bytes = priv_pem.as_bytes().to_vec();
    (signing, pub_pem, priv_pem_bytes)
}

#[tokio::test]
async fn verifies_a_known_good_jwt() {
    let server = MockServer::start().await;
    let (_signing, pub_pem, priv_pem_bytes) = ed25519_pem_pair();

    Mock::given(method("GET"))
        .and(path("/.well-known/fdkey.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "issuer": "test",
            "keys": [{
                "alg": "EdDSA",
                "kid": "k1",
                "public_key_pem": pub_pem,
            }],
            "jwt_default_lifetime_seconds": 600,
        })))
        .mount(&server)
        .await;

    let now = now_secs();
    let claims = Claims {
        iss: "test",
        sub: "session-1",
        aud: "tester",
        iat: now,
        nbf: now,
        exp: now + 600,
        score: 0.75,
        tier: "silver",
    };
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some("k1".to_string());
    let key = EncodingKey::from_ed_pem(&priv_pem_bytes).unwrap();
    let token = encode(&header, &claims, &key).unwrap();

    let cfg = FdkeyConfig {
        api_key: "fdk_test".into(),
        vps_url: Some(server.uri()),
        ..Default::default()
    };
    let verifier = Verifier::new(&cfg).unwrap();
    let v = verifier.verify_token(&token).await.expect("verify ok");
    assert_eq!(v.score, 0.75);
    assert_eq!(v.tier, "silver");
}

#[tokio::test]
async fn rejects_unknown_kid() {
    let server = MockServer::start().await;
    let (_, pub_pem, _) = ed25519_pem_pair();

    Mock::given(method("GET"))
        .and(path("/.well-known/fdkey.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "issuer": "test",
            "keys": [{
                "alg": "EdDSA",
                "kid": "k1",
                "public_key_pem": pub_pem,
            }],
            "jwt_default_lifetime_seconds": 600,
        })))
        .mount(&server)
        .await;

    // Sign with a different keypair AND a different kid.
    let (_, _, other_priv) = ed25519_pem_pair();
    let now = now_secs();
    let claims = Claims {
        iss: "test",
        sub: "s",
        aud: "t",
        iat: now,
        nbf: now,
        exp: now + 600,
        score: 1.0,
        tier: "gold",
    };
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some("no-such-kid".into());
    let key = EncodingKey::from_ed_pem(&other_priv).unwrap();
    let token = encode(&header, &claims, &key).unwrap();

    let cfg = FdkeyConfig {
        api_key: "fdk_test".into(),
        vps_url: Some(server.uri()),
        ..Default::default()
    };
    let verifier = Verifier::new(&cfg).unwrap();
    assert!(verifier.verify_token(&token).await.is_err());
}

#[test]
fn extract_bearer_parses_standard_header() {
    assert_eq!(extract_bearer(Some("Bearer abc.def.ghi")), Some("abc.def.ghi"));
    assert_eq!(extract_bearer(Some("bearer abc.def")), Some("abc.def"));
    assert_eq!(extract_bearer(Some("BEARER abc")), Some("abc"));
    assert_eq!(extract_bearer(Some("")), None);
    assert_eq!(extract_bearer(Some("Bearer")), None);
    assert_eq!(extract_bearer(Some("Token abc")), None);
    assert_eq!(extract_bearer(None), None);
}

#[test]
fn guard_each_call_consumes_ticket() {
    let policy = Policy::EachCall;
    let mut s = SessionState::default();
    assert!(!can_call(&policy, "x", &s));
    mark_verified(&mut s);
    assert!(can_call(&policy, "x", &s));
    consume_policy(&policy, &mut s);
    assert!(!can_call(&policy, "x", &s));
}

#[test]
fn guard_once_per_session_persists() {
    let policy = Policy::OncePerSession;
    let mut s = SessionState::default();
    assert!(!can_call(&policy, "x", &s));
    mark_verified(&mut s);
    assert!(can_call(&policy, "x", &s));
    consume_policy(&policy, &mut s);
    assert!(can_call(&policy, "x", &s)); // still passes
}

#[test]
fn guard_every_minutes_window() {
    let policy = Policy::EveryMinutes { minutes: 1 };
    let mut s = SessionState::default();
    assert!(!can_call(&policy, "x", &s));
    mark_verified(&mut s);
    assert!(can_call(&policy, "x", &s));
    // Move the verified_at into the past.
    s.verified_at_ms = Some(s.verified_at_ms.unwrap() - 65_000);
    assert!(!can_call(&policy, "x", &s));
}

#[tokio::test]
async fn well_known_concurrent_first_use_coalesces_to_one_fetch() {
    // Property under test: when N concurrent callers arrive on a cold
    // WellKnownClient, exactly ONE network fetch should fire — the others
    // wait on the refresh-mutex and read the freshly-populated cache.
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use wiremock::{matchers::method as method_m, matchers::path as path_m, Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let (_signing, pub_pem, _priv_pem) = ed25519_pem_pair();

    // Wiremock doesn't natively expose a hit counter via Mock::expect that
    // we can read post-hoc; we wrap the responder in a counter using a
    // shared AtomicUsize via a custom Respond impl.
    let hits: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let pem = pub_pem.clone();

    struct Counter {
        hits: Arc<AtomicUsize>,
        body: serde_json::Value,
    }
    impl wiremock::Respond for Counter {
        fn respond(&self, _: &wiremock::Request) -> ResponseTemplate {
            self.hits.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200).set_body_json(self.body.clone())
        }
    }

    Mock::given(method_m("GET"))
        .and(path_m("/.well-known/fdkey.json"))
        .respond_with(Counter {
            hits: hits.clone(),
            body: serde_json::json!({
                "issuer": "test",
                "keys": [{ "alg": "EdDSA", "kid": "k1", "public_key_pem": pem }],
                "jwt_default_lifetime_seconds": 600,
            }),
        })
        .mount(&server)
        .await;

    let client = WellKnownClient::new(server.uri()).expect("WellKnownClient::new failed");

    // Spawn 16 concurrent get_key calls on a cold cache. They should all
    // succeed AND the wiremock should record exactly 1 hit — proving the
    // refresh-lock coalesces.
    let mut handles = Vec::new();
    for _ in 0..16 {
        let c = client.clone();
        handles.push(tokio::spawn(async move { c.get_key("k1").await }));
    }
    for h in handles {
        let key = h.await.expect("task panic").expect("get_key err");
        assert!(key.is_some(), "kid 'k1' must be returned to every caller");
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "well-known should be fetched exactly once across 16 concurrent first-use calls",
    );
}
