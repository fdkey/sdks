/** `/.well-known/fdkey.json` cache. Same shape as the @fdkey/mcp version —
 *  Map<kid, KeyLike> cached for 1h, refresh on unknown kid (handles
 *  mid-rotation gracefully). */

import { importSPKI, type KeyLike } from 'jose';

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface WellKnownKey {
  alg: string;
  kid: string;
  public_key_pem: string;
}

interface WellKnownPayload {
  issuer: string;
  keys: WellKnownKey[];
  jwt_default_lifetime_seconds: number;
}

interface KeyCache {
  keys: Map<string, KeyLike>;
  fetchedAt: number;
}

export class WellKnownClient {
  private cache: KeyCache | null = null;
  /** In-flight refresh promise — when N concurrent first-use callers
   *  arrive on a cold cache, the first triggers a refresh and the rest
   *  await the same Promise. Without this, all N would each fire their
   *  own GET /.well-known/fdkey.json, hammering the VPS for the same
   *  payload. The Rust SDK has equivalent coalescing via RwLock + Mutex;
   *  this is the JS-flavored version. */
  private inflight: Promise<void> | null = null;

  constructor(private readonly vpsBase: string) {}

  async getKey(kid: string): Promise<KeyLike | null> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      const k = this.cache.keys.get(kid);
      if (k) return k;
      // kid not in cache — may have just rotated, refetch once
    }
    await this.refreshCoalesced();
    return this.cache?.keys.get(kid) ?? null;
  }

  private refreshCoalesced(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.refresh().finally(() => {
      // Whether the refresh succeeded or threw, clear the in-flight slot
      // so the next miss after recovery actually retries. Concurrent
      // callers awaiting `p` see the same outcome (success → cache
      // populated; failure → exception propagated).
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(`${this.vpsBase}/.well-known/fdkey.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`fdkey: well-known fetch failed ${res.status}`);
    }
    const payload = (await res.json()) as WellKnownPayload;
    const keys = new Map<string, KeyLike>();
    for (const k of payload.keys) {
      const key = await importSPKI(k.public_key_pem, k.alg);
      keys.set(k.kid, key);
    }
    this.cache = { keys, fetchedAt: Date.now() };
  }
}
