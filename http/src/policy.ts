/** Per-session re-verification policy. Mirrors the @fdkey/mcp guard module. */

export type PolicyShorthand = 'once_per_session';

export type Policy =
  | { type: 'once_per_session' }
  | { type: 'every_minutes'; minutes: number };

export function normalisePolicy(p: Policy | PolicyShorthand | undefined): Policy {
  if (!p) return { type: 'once_per_session' };
  if (typeof p === 'string') return { type: p };
  return p;
}

/** True if a session that was verified at `verifiedAtMs` still satisfies
 *  the policy at time `nowMs`. */
export function sessionStillValid(
  policy: Policy,
  verifiedAtMs: number,
  nowMs: number,
): boolean {
  switch (policy.type) {
    case 'once_per_session':
      return true;
    case 'every_minutes':
      return nowMs - verifiedAtMs < policy.minutes * 60 * 1000;
  }
}
