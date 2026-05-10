/** Internal Ed25519 JWT verification. The agent NEVER sees a JWT in the
 *  session-mediated flow — we keep one server-side as a verification
 *  artifact, decode it once on receipt, and discard. */

import { jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import type { WellKnownClient } from './well-known.js';
import type { VerifiedSession } from './types.js';

export class JwtVerifier {
  constructor(private readonly wellKnown: WellKnownClient) {}

  /** Verify a freshly-issued JWT from the VPS and extract the verified-session
   *  data. Returns null on any failure (missing kid, unknown kid, bad
   *  signature, expired). The caller should treat null as "verification
   *  failed even though the VPS said pass" — typically a kid-rotation race
   *  or a misconfigured VPS. */
  async verify(token: string): Promise<VerifiedSession | null> {
    let header: { kid?: string };
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return null;
    }
    const kid = header.kid;
    if (!kid) return null;

    const key = await this.wellKnown.getKey(kid);
    if (!key) return null;

    try {
      // 30s tolerance — covers NTP drift between the VPS issuing the JWT and
      // the integrator's host receiving it.
      await jwtVerify(token, key, { clockTolerance: 30 });
    } catch {
      return null;
    }

    const claims = decodeJwt(token) as Record<string, unknown>;
    const score = typeof claims.score === 'number' ? claims.score : 0;
    const tier = typeof claims.tier === 'string' ? claims.tier : '';
    return {
      verifiedAt: Date.now(),
      score,
      tier,
      claims,
    };
  }
}
