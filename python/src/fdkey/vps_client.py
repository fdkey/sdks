"""HTTP client for api.fdkey.com — fetch challenge, submit answers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import httpx

REQUEST_TIMEOUT_SECONDS = 10.0


class VpsHttpError(Exception):
    """Raised on non-2xx responses from the VPS. Carries status + body."""

    def __init__(self, status: int, body: dict[str, Any]) -> None:
        super().__init__(body.get("error") or f"HTTP {status}")
        self.status = status
        self.body = body


@dataclass
class ChallengeResponse:
    challenge_id: str
    expires_at: str
    expires_in_seconds: Optional[int]
    difficulty: str
    types_served: list[str]
    header: Optional[str]
    puzzles: dict[str, Any]
    footer: Optional[str]


@dataclass
class SubmitResponse:
    verified: bool
    jwt: Optional[str]
    types_passed: Optional[int]
    types_served: Optional[int]
    required_to_pass: Optional[int]
    breakdown: Optional[dict[str, Any]]


class VpsClient:
    def __init__(self, vps_url: str, api_key: str, difficulty: str) -> None:
        self._vps_url = vps_url
        self._api_key = api_key
        self._difficulty = difficulty
        # Reuse one AsyncClient across calls so httpx keeps the underlying
        # HTTP/1.1 keepalive (or HTTP/2) connection pool warm. Constructing
        # one per call defeats pooling and forces a fresh TCP+TLS handshake
        # on every challenge / submit.
        self._client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS)

    async def aclose(self) -> None:
        """Release the underlying connection pool. Safe to call multiple times.
        Optional — Python will close on GC, but explicit close is preferred
        for long-lived servers that drop and recreate the SDK at runtime."""
        await self._client.aclose()

    async def fetch_challenge(self, meta: Optional[dict[str, Any]] = None) -> ChallengeResponse:
        body: dict[str, Any] = {
            "difficulty": self._difficulty,
            "client_type": "mcp",
        }
        if meta:
            for block in ("agent", "integrator"):
                v = meta.get(block)
                if v and any(x is not None for x in v.values()):
                    body[block] = v
            tags = meta.get("tags")
            if tags:
                body["tags"] = tags
        payload = await self._post("/v1/challenge", body)
        return ChallengeResponse(
            challenge_id=payload["challenge_id"],
            expires_at=payload["expires_at"],
            expires_in_seconds=payload.get("expires_in_seconds"),
            difficulty=payload["difficulty"],
            types_served=payload.get("types_served", []),
            header=payload.get("header"),
            puzzles=payload.get("puzzles", {}),
            footer=payload.get("footer"),
        )

    async def submit_answers(
        self, challenge_id: str, answers: dict[str, Any]
    ) -> SubmitResponse:
        payload = await self._post(
            "/v1/submit", {"challenge_id": challenge_id, "answers": answers}
        )
        return SubmitResponse(
            verified=bool(payload.get("verified", False)),
            jwt=payload.get("jwt"),
            types_passed=payload.get("types_passed"),
            types_served=payload.get("types_served"),
            required_to_pass=payload.get("required_to_pass"),
            breakdown=payload.get("breakdown"),
        )

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._vps_url}{path}"
        res = await self._client.post(
            url,
            json=body,
            headers={"Authorization": f"Bearer {self._api_key}"},
        )
        try:
            parsed = res.json()
        except Exception:
            parsed = {"_raw": res.text}
        if res.status_code >= 400:
            raise VpsHttpError(res.status_code, parsed)
        return parsed
