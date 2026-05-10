"""Ed25519 JWT verification using PyJWT[crypto]. Same wire shape as TS SDK."""

from __future__ import annotations

from typing import Any, Optional

import jwt as pyjwt

from .well_known import WellKnownClient

CLOCK_TOLERANCE_SECONDS = 30


class JwtVerifier:
    """Wraps WellKnownClient and pyjwt to verify FDKEY-issued tokens.

    Returns the decoded claims dict on success, None on any failure
    (missing kid, unknown kid, bad signature, expired). Caller treats
    None as 'verification failed' and surfaces accordingly."""

    def __init__(self, well_known: WellKnownClient) -> None:
        self._well_known = well_known

    async def verify(self, token: str) -> Optional[dict[str, Any]]:
        try:
            header = pyjwt.get_unverified_header(token)
        except Exception:
            return None
        kid = header.get("kid")
        if not kid:
            return None
        key = await self._well_known.get_key(kid)
        if key is None:
            return None
        try:
            claims = pyjwt.decode(
                token,
                key=key,
                algorithms=["EdDSA"],
                leeway=CLOCK_TOLERANCE_SECONDS,
                # FDKEY's audience is the integrator's vps_users.id, which
                # the SDK doesn't know at verify time. We accept any aud
                # for now (the VPS already binds aud to the api_key that
                # requested the challenge — defense in depth).
                options={"verify_aud": False},
            )
        except Exception:
            return None
        if not isinstance(claims, dict):
            return None
        return claims


def extract_score(claims: Optional[dict[str, Any]]) -> Optional[float]:
    if not claims:
        return None
    v = claims.get("score")
    if isinstance(v, (int, float)):
        return float(v)
    return None


def extract_tier(claims: Optional[dict[str, Any]]) -> Optional[str]:
    if not claims:
        return None
    v = claims.get("tier")
    if isinstance(v, str):
        return v
    return None
