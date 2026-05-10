import type { Policy, SessionState } from './types.js';

export function newSession(): SessionState {
  return {
    verified: false,
    verifiedAt: null,
    lastTouchedAt: Date.now(),
    freshVerificationAvailable: false,
    pendingChallengeId: null,
    lastClaims: null,
    clientInfo: null,
    protocolVersion: null,
    mcpSessionId: null,
    transport: 'unknown',
  };
}

/**
 * Decides whether a protected tool call passes given the current policy and session state.
 *
 *   once_per_session: pass if the session has ever been verified.
 *   each_call:        pass only if there is an unconsumed fresh verification ticket.
 *   every_minutes: N: pass if (now - verifiedAt) < N minutes — the timer does NOT
 *                     extend on calls; it expires N minutes after the puzzle was solved.
 */
export function canCall(policy: Policy, _toolName: string, session: SessionState): boolean {
  switch (policy.type) {
    case 'once_per_session':
      return session.verified;
    case 'each_call':
      return session.verified && session.freshVerificationAvailable;
    case 'every_minutes': {
      if (session.verifiedAt === null) return false;
      return Date.now() - session.verifiedAt < policy.minutes * 60 * 1000;
    }
  }
}

/** Called only when fdkey_submit_challenge succeeds. Replenishes session state. */
export function markVerified(session: SessionState): void {
  session.verified = true;
  session.verifiedAt = Date.now();
  session.freshVerificationAvailable = true;
}

/** Called after a protected tool call completes. Consumes the fresh-verification
 *  ticket for each_call policies. once_per_session and every_minutes do nothing. */
export function consumePolicy(policy: Policy, session: SessionState): void {
  if (policy.type === 'each_call') {
    session.freshVerificationAvailable = false;
  }
}
