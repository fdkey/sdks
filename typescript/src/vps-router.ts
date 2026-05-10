import { Agent, fetch } from 'undici';
import type { LookupOptions } from 'node:dns';
import type { VpsEndpoint, IVpsRouter, RoutingTarget } from './types.js';

// Node's `net.connect` lookup option supports two callback signatures:
//   - opts.all === true:  cb(err, [{address, family}, …])
//   - otherwise:          cb(err, address, family)
// We support both because some Node versions / undici paths pass
// `opts.all = true` and expect the array form.
type SingleLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number
) => void;
type MultiLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: { address: string; family: number }[]
) => void;
type LookupFn = (
  hostname: string,
  options: LookupOptions,
  cb: SingleLookupCallback | MultiLookupCallback
) => void;

const DEFAULT_DISCOVERY_URL = 'https://cdn.fdkey.com/endpoints.json';
/** All FDKEY VPSs serve TLS for this hostname. The SDK uses it as the SNI
 *  value when connecting to any IP from the discovery list — every box in
 *  the fleet holds a Let's Encrypt cert for this name (acquired via the
 *  DNS-01 challenge so multiple boxes can share the cert without
 *  fighting over HTTP-01). */
const FDKEY_API_HOSTNAME = 'api.fdkey.com';
const PROBE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DISCOVERY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedEndpoints {
  endpoints: VpsEndpoint[];
  fetchedAt: number;
}

/** Multi-VPS discovery + IP-pinning router. Fetch endpoint list from cdn.fdkey.com, parallel-probe
 *  each IP via HEAD https://api.fdkey.com/health pinned to that IP, sort
 *  by (error count ASC, latency ASC), pick winner. Re-probe every hour or
 *  on `recordFailure(ip)`. */
export class VpsRouter implements IVpsRouter {
  private readonly discoveryUrl: string;
  private endpointCache: CachedEndpoints | null = null;
  private selectedIp: string | null = null;
  private dispatchers = new Map<string, Agent>();
  private latencies = new Map<string, number>();
  private errorCounts = new Map<string, number>();
  private nextProbe = 0;

  constructor(discoveryUrl?: string) {
    this.discoveryUrl = discoveryUrl ?? DEFAULT_DISCOVERY_URL;
  }

  async getTarget(): Promise<RoutingTarget> {
    if (!this.selectedIp || Date.now() >= this.nextProbe) {
      await this.refreshEndpoints();
    }
    const ip = this.selectedIp!;
    return {
      url: `https://${FDKEY_API_HOSTNAME}`,
      dispatcher: this.dispatcherFor(ip),
      ip,
    };
  }

  recordFailure(ip: string | undefined): void {
    if (!ip) return;
    this.errorCounts.set(ip, (this.errorCounts.get(ip) ?? 0) + 1);
    if (this.selectedIp === ip) {
      this.selectedIp = null; // force re-selection next call
    }
  }

  /** Build (and cache) an undici Agent that pins all connections to `ip`
   *  while leaving SNI and cert validation to use the URL's hostname.
   *  Dispatchers are reused across calls — creating a new one per request
   *  would defeat the connection-pooling benefits. */
  private dispatcherFor(ip: string): Agent {
    let d = this.dispatchers.get(ip);
    if (d) return d;
    const lookup: LookupFn = (_host, opts, cb) => {
      if (opts.all) {
        (cb as MultiLookupCallback)(null, [{ address: ip, family: 4 }]);
      } else {
        (cb as SingleLookupCallback)(null, ip, 4);
      }
    };
    d = new Agent({
      connect: {
        // Hand undici a custom resolver: regardless of what hostname is
        // being requested, return this IP. The TLS handshake still uses
        // the URL's hostname for SNI + cert verification, which is what
        // makes the IP-pin trick work.
        lookup,
      },
    });
    this.dispatchers.set(ip, d);
    return d;
  }

  private async refreshEndpoints(): Promise<void> {
    const endpoints = await this.fetchEndpoints();
    const active = endpoints.filter((e) => !e.deprecated);
    if (active.length === 0) {
      throw new Error('fdkey: no active VPS endpoints found in discovery list');
    }

    const results = await this.probeAll(active);
    // Sort by (error_count ASC, latency ASC). Endpoints that didn't respond
    // to the probe get latency = Infinity and rank last among equal error
    // counts — but they're still candidates if everything else is dead.
    results.sort((a, b) => {
      const ea = this.errorCounts.get(a.ip) ?? 0;
      const eb = this.errorCounts.get(b.ip) ?? 0;
      if (ea !== eb) return ea - eb;
      return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
    });

    this.selectedIp = results[0].ip;
    this.nextProbe = Date.now() + PROBE_INTERVAL_MS;
  }

  private async fetchEndpoints(): Promise<VpsEndpoint[]> {
    if (
      this.endpointCache &&
      Date.now() - this.endpointCache.fetchedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      return this.endpointCache.endpoints;
    }
    try {
      const res = await fetch(this.discoveryUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`discovery fetch ${res.status}`);
      const data = (await res.json()) as VpsEndpoint[];
      this.endpointCache = { endpoints: data, fetchedAt: Date.now() };
      return data;
    } catch (err) {
      if (this.endpointCache) return this.endpointCache.endpoints; // stale ok
      throw new Error(`fdkey: cannot reach discovery URL and no cached endpoints: ${err}`);
    }
  }

  /** HEAD https://api.fdkey.com/health pinned per-IP. We use a per-call
   *  ad-hoc dispatcher (not the cached one) so a probe failure doesn't
   *  leave a soured connection in the pool. */
  private async probeAll(
    endpoints: VpsEndpoint[]
  ): Promise<Array<{ ip: string; latencyMs: number | null }>> {
    return Promise.all(
      endpoints.map(async (e) => {
        const start = Date.now();
        try {
          const probeLookup: LookupFn = (_h, opts, cb) => {
            if (opts.all) {
              (cb as MultiLookupCallback)(null, [{ address: e.ip, family: 4 }]);
            } else {
              (cb as SingleLookupCallback)(null, e.ip, 4);
            }
          };
          const probeAgent = new Agent({
            connect: { lookup: probeLookup },
          });
          await fetch(`https://${FDKEY_API_HOSTNAME}/health`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
            dispatcher: probeAgent,
          });
          await probeAgent.close();
          const latencyMs = Date.now() - start;
          this.latencies.set(e.ip, latencyMs);
          return { ip: e.ip, latencyMs };
        } catch {
          return { ip: e.ip, latencyMs: null };
        }
      })
    );
  }
}
