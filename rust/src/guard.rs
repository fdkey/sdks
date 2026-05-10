//! Pure-function policy evaluation. Mirrors `guard.ts` / `guard.py`.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{Policy, SessionState};

/// True iff the session's verification state satisfies the policy.
pub fn can_call(policy: &Policy, _tool_name: &str, session: &SessionState) -> bool {
    match policy {
        Policy::OncePerSession => session.verified,
        Policy::EachCall => session.verified && session.fresh_verification_available,
        Policy::EveryMinutes { minutes } => match session.verified_at_ms {
            None => false,
            Some(t) => now_ms() - t < (*minutes as i64) * 60 * 1000,
        },
    }
}

/// Called only when the submit step succeeds. Replenishes session state.
pub fn mark_verified(session: &mut SessionState) {
    session.verified = true;
    session.verified_at_ms = Some(now_ms());
    session.fresh_verification_available = true;
}

/// Called after a protected tool call completes. Consumes the
/// fresh-verification ticket for `EachCall`; no-op for other policies.
pub fn consume_policy(policy: &Policy, session: &mut SessionState) {
    if matches!(policy, Policy::EachCall) {
        session.fresh_verification_available = false;
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
