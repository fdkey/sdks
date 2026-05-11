/**
 * Short-lived HMAC-signed tickets that authorize an agent to call
 * `/fdkey/challenge` and `/fdkey/submit`.
 *
 * Issued by the SDK when a protected route returns 402, returned to the
 * agent in the 402 body as `challenge_ticket`. The agent presents it via
 * `Authorization: Bearer <ticket>` on subsequent SDK endpoint calls. Bound
 * to a specific session id (the same UUID the cookie carries) so a ticket
 * issued for one session can't be replayed against another.
 *
 * Stateless: nothing is stored server-side per ticket — verification is
 * pure signature + claim check. Reusable within the TTL (default 5 min)
 * so an agent that fetches a challenge, fails, refreshes, then submits
 * uses the same ticket throughout. If we ever need single-use semantics,
 * add a JTI + revoke list on top.
 *
 * Format: compact JWS (JWT) signed with HS256.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/** Default ticket lifetime when integrators don't override. 5 minutes is
 *  long enough for a slow agent to fetch, solve, and submit; short enough
 *  that a leaked ticket isn't a long-lived authorization. */
export const DEFAULT_TICKET_TTL_SECONDS = 300;

/** Minimum acceptable `ticketSecret` length in bytes. HS256 requires the
 *  secret to be at least as long as the hash output (32 bytes / 256 bits)
 *  for full security guarantees. We refuse shorter values at startup. */
export const MIN_TICKET_SECRET_BYTES = 32;

const ISSUER = 'fdkey-http-sdk';

/** Thrown by `verifyTicket()` when the token is past its `exp` claim.
 *  Surface to the agent as 401 `fdkey_ticket_expired`. */
export class TicketExpiredError extends Error {
  readonly code = 'fdkey_ticket_expired' as const;
  constructor() {
    super('Ticket expired');
  }
}

/** Thrown by `verifyTicket()` for any other validation failure (bad
 *  signature, malformed JWT, wrong issuer, missing claims). Surface to
 *  the agent as 401 `fdkey_ticket_invalid`. */
export class TicketInvalidError extends Error {
  readonly code = 'fdkey_ticket_invalid' as const;
  constructor(reason: string) {
    super(`Ticket invalid: ${reason}`);
  }
}

/** Sign a fresh ticket bound to `sid`. `ttlSeconds` defaults to
 *  `DEFAULT_TICKET_TTL_SECONDS`. */
export async function signTicket(
  secret: Uint8Array,
  sid: string,
  ttlSeconds: number = DEFAULT_TICKET_TTL_SECONDS,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(secret);
}

/** Verify a ticket. Returns the bound `sid` on success, throws
 *  `TicketExpiredError` or `TicketInvalidError` on failure. Does NOT
 *  check that the sid matches a caller-supplied value — caller compares
 *  against the session cookie themselves. */
export async function verifyTicket(
  secret: Uint8Array,
  token: string,
): Promise<{ sid: string }> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, secret, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new TicketExpiredError();
    }
    if (err instanceof Error) {
      throw new TicketInvalidError(err.message);
    }
    throw new TicketInvalidError('unknown verify error');
  }
  const sid = payload['sid'];
  if (typeof sid !== 'string' || sid.length === 0) {
    throw new TicketInvalidError('missing or non-string sid claim');
  }
  return { sid };
}

/** Convert a string secret to bytes. Stable across runtimes (Node, Workers,
 *  Bun, Deno) via the built-in `TextEncoder`. */
export function secretToBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
