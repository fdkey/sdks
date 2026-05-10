"""Smoke tests for the JWT verify path: well-known fetch + Ed25519 verify."""

from __future__ import annotations

import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PrivateFormat,
    PublicFormat,
    NoEncryption,
)

from fdkey.jwt_verify import JwtVerifier, extract_score, extract_tier
from fdkey.well_known import WellKnownClient


KID = "test-kid-1"
VPS_BASE = "https://api.test"


def _make_keypair() -> tuple[bytes, bytes]:
    priv = Ed25519PrivateKey.generate()
    pem_priv = priv.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    )
    pem_pub = priv.public_key().public_bytes(
        encoding=Encoding.PEM,
        format=PublicFormat.SubjectPublicKeyInfo,
    )
    return pem_priv, pem_pub


def _sign(payload: dict, pem_priv: bytes) -> str:
    return pyjwt.encode(
        payload,
        pem_priv.decode("utf-8"),
        algorithm="EdDSA",
        headers={"kid": KID},
    )


@pytest.mark.asyncio
async def test_verify_returns_claims_on_valid_token(respx_mock):
    pem_priv, pem_pub = _make_keypair()
    respx_mock.get(f"{VPS_BASE}/.well-known/fdkey.json").respond(
        200,
        json={
            "issuer": "test",
            "keys": [{"alg": "EdDSA", "kid": KID, "public_key_pem": pem_pub.decode()}],
            "jwt_default_lifetime_seconds": 600,
        },
    )

    now = int(time.time())
    token = _sign(
        {
            "iss": "test",
            "sub": "session-1",
            "aud": "tester",
            "iat": now,
            "nbf": now,
            "exp": now + 600,
            "score": 0.75,
            "tier": "silver",
        },
        pem_priv,
    )

    wk = WellKnownClient(VPS_BASE)
    verifier = JwtVerifier(wk)
    claims = await verifier.verify(token)
    assert claims is not None
    assert claims["score"] == 0.75
    assert claims["tier"] == "silver"


@pytest.mark.asyncio
async def test_verify_returns_none_on_unknown_kid(respx_mock):
    _, pem_pub = _make_keypair()
    other_priv, _ = _make_keypair()
    respx_mock.get(f"{VPS_BASE}/.well-known/fdkey.json").respond(
        200,
        json={
            "issuer": "test",
            "keys": [{"alg": "EdDSA", "kid": KID, "public_key_pem": pem_pub.decode()}],
            "jwt_default_lifetime_seconds": 600,
        },
    )

    now = int(time.time())
    token = pyjwt.encode(
        {"iss": "test", "sub": "s", "iat": now, "exp": now + 600},
        other_priv.decode("utf-8"),
        algorithm="EdDSA",
        headers={"kid": "no-such-kid"},
    )

    wk = WellKnownClient(VPS_BASE)
    verifier = JwtVerifier(wk)
    assert (await verifier.verify(token)) is None


def test_extract_score_handles_missing_or_wrong_type():
    assert extract_score(None) is None
    assert extract_score({}) is None
    assert extract_score({"score": "1"}) is None
    assert extract_score({"score": 1}) == 1.0
    assert extract_score({"score": 0.5}) == 0.5


def test_extract_tier_handles_missing_or_wrong_type():
    assert extract_tier(None) is None
    assert extract_tier({}) is None
    assert extract_tier({"tier": 5}) is None
    assert extract_tier({"tier": "gold"}) == "gold"
