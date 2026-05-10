"""Cached fetcher for ${vps_base}/.well-known/fdkey.json. Mirrors the TS
SDK's well-known.ts — Map<kid, public_key> cached for 1 hour, refreshes
on unknown kid (mid-rotation handling)."""

from __future__ import annotations

import time
from typing import Optional

import httpx
from cryptography.hazmat.primitives.serialization import load_pem_public_key

CACHE_TTL_SECONDS = 60 * 60  # 1 hour


class WellKnownClient:
    def __init__(self, vps_base: str) -> None:
        self._vps_base = vps_base
        self._keys: dict[str, object] = {}
        self._fetched_at: float = 0.0
        # Reused across refreshes so we keep the keepalive pool to api.fdkey.com.
        self._client = httpx.AsyncClient(timeout=5.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_key(self, kid: str) -> Optional[object]:
        if self._keys and time.time() - self._fetched_at < CACHE_TTL_SECONDS:
            k = self._keys.get(kid)
            if k is not None:
                return k
            # kid not in cache — may have just rotated; refetch once
        await self._refresh()
        return self._keys.get(kid)

    async def _refresh(self) -> None:
        url = f"{self._vps_base}/.well-known/fdkey.json"
        res = await self._client.get(url)
        if res.status_code != 200:
            raise RuntimeError(
                f"fdkey: well-known fetch failed {res.status_code}"
            )
        payload = res.json()
        keys: dict[str, object] = {}
        for k in payload.get("keys", []):
            pem = k["public_key_pem"]
            keys[k["kid"]] = load_pem_public_key(pem.encode("utf-8"))
        self._keys = keys
        self._fetched_at = time.time()
