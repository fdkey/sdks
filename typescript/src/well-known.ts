import { importSPKI, type KeyLike } from 'jose';
import type { WellKnownPayload, IVpsRouter } from './types.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface KeyCache {
  keys: Map<string, KeyLike>;
  fetchedAt: number;
}

/** Fetches and caches the public-key list at `${vpsBase}/.well-known/fdkey.json`.
 *  Goes through the VpsRouter so the request lands on the same IP currently
 *  serving production traffic (and uses the same dispatcher / SNI / cert
 *  handling — just like challenge/submit calls). */
export class WellKnownClient {
  private cache: KeyCache | null = null;

  constructor(private readonly router: IVpsRouter) {}

  async getKey(kid: string): Promise<KeyLike | null> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      const k = this.cache.keys.get(kid);
      if (k) return k;
      // kid not in cache — may have just rotated, refetch once
    }
    await this.refresh();
    return this.cache!.keys.get(kid) ?? null;
  }

  private async refresh(): Promise<void> {
    const target = await this.router.getTarget();
    const init: RequestInit & { dispatcher?: unknown } = {
      signal: AbortSignal.timeout(5000),
    };
    if (target.dispatcher) init.dispatcher = target.dispatcher;
    const res = await fetch(
      `${target.url}/.well-known/fdkey.json`,
      init as RequestInit
    );
    if (!res.ok) throw new Error(`fdkey: well-known fetch failed ${res.status}`);
    const payload = (await res.json()) as WellKnownPayload;
    const keys = new Map<string, KeyLike>();
    for (const k of payload.keys) {
      const key = await importSPKI(k.public_key_pem, k.alg);
      keys.set(k.kid, key);
    }
    this.cache = { keys, fetchedAt: Date.now() };
  }
}
