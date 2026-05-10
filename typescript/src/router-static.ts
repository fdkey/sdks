import type { IVpsRouter, RoutingTarget } from './types.js';

/** Used when the SDK consumer passes an explicit `vpsUrl` (or accepts the
 *  default `https://api.fdkey.com`). Bypasses all discovery and probing —
 *  fetch uses its default DNS resolution against whatever hostname (or IP)
 *  is in the URL. No `dispatcher` is set, so this works on every runtime
 *  that has a global `fetch` (Node 18+, Cloudflare Workers, Bun, Deno). */
export class StaticRouter implements IVpsRouter {
  constructor(private readonly url: string) {}
  async getTarget(): Promise<RoutingTarget> {
    return { url: this.url };
  }
  recordFailure(_ip: string | undefined): void {}
}
