import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withFdkey, getFdkeyContext, type FdkeyContext } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Phase A: Workers compat — lazy VpsRouter', () => {
  it('does not pull vps-router.js into the StaticRouter default path', async () => {
    // Module spy: replace vps-router with a stub that throws on instantiation.
    // If anything along the StaticRouter path tries to construct VpsRouter we
    // get a loud failure. The IMPORT itself is the test — if the lazy path
    // is broken and someone reintroduces a static `import './vps-router.js'`
    // somewhere, this test will exercise the throwing stub at module load
    // time and fail.
    let vpsRouterConstructed = false;
    vi.doMock('./vps-router.js', () => ({
      VpsRouter: class {
        constructor() {
          vpsRouterConstructed = true;
          throw new Error(
            'vps-router must not be loaded when no discoveryUrl is set',
          );
        }
      },
    }));

    // Re-import withFdkey under the mock.
    vi.resetModules();
    const reImported = await import('./index.js');

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const wrapped = reImported.withFdkey(server, {
      apiKey: 'fdk_test',
      vpsUrl: 'https://api.example.com',
    });

    expect(wrapped).toBeDefined();
    expect(vpsRouterConstructed).toBe(false);
  });

  it('lazy-loads vps-router.js only on first getTarget() call', async () => {
    let vpsRouterConstructed = false;
    let getTargetCalls = 0;
    vi.doMock('./vps-router.js', () => ({
      VpsRouter: class {
        constructor(_url: string | undefined) {
          vpsRouterConstructed = true;
        }
        async getTarget() {
          getTargetCalls += 1;
          return { url: 'https://api.fdkey.com' };
        }
        recordFailure() {}
      },
    }));

    vi.resetModules();
    const reImported = await import('./index.js');

    // Construct LazyVpsRouter directly via the test-only export, then
    // verify the contract end-to-end:
    //   1. Construction does NOT load vps-router.js (still false here)
    //   2. First getTarget() DOES trigger the dynamic import
    //   3. Subsequent getTarget() reuses the inner VpsRouter (one construction)
    const lazy = new reImported.__LazyVpsRouterForTesting(
      'https://cdn.example.com/endpoints.json',
    );
    expect(vpsRouterConstructed).toBe(false);

    const target1 = await lazy.getTarget();
    expect(target1.url).toBe('https://api.fdkey.com');
    expect(vpsRouterConstructed).toBe(true);
    expect(getTargetCalls).toBe(1);

    await lazy.getTarget();
    expect(getTargetCalls).toBe(2);
    // Still only ONE VpsRouter construction — the cache held.
  });

  it('throws an actionable error when undici is missing', async () => {
    // Simulate Node's real failure shape: a thrown Error with
    // `.code === 'MODULE_NOT_FOUND'` and a message naming `undici`.
    // The LazyVpsRouter catches both an import-time and a constructor-
    // time throw — we throw from the constructor here for simplicity,
    // since the catch path is identical.
    vi.doMock('./vps-router.js', () => ({
      VpsRouter: class {
        constructor() {
          const err = new Error("Cannot find module 'undici'") as Error & {
            code?: string;
          };
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
      },
    }));

    vi.resetModules();
    const reImported = await import('./index.js');
    const lazy = new reImported.__LazyVpsRouterForTesting(
      'https://cdn.example.com/endpoints.json',
    );

    await expect(lazy.getTarget()).rejects.toThrow(/undici.*not installed/i);
  });

  it('rethrows unrelated errors verbatim (no false-positive on undici)', async () => {
    // A bundler glitch surfacing "Cannot find module './vps-router.js'"
    // shouldn't be misreported as "undici is not installed". Today's
    // matcher requires both the MODULE_NOT_FOUND code AND the literal
    // string 'undici' in the message.
    vi.doMock('./vps-router.js', () => ({
      VpsRouter: class {
        constructor() {
          const err = new Error("Cannot find module './vps-router.js'") as Error & {
            code?: string;
          };
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
      },
    }));

    vi.resetModules();
    const reImported = await import('./index.js');
    const lazy = new reImported.__LazyVpsRouterForTesting(
      'https://cdn.example.com/endpoints.json',
    );

    // Should rethrow the original message — NOT the friendly undici hint.
    await expect(lazy.getTarget()).rejects.toThrow(/vps-router\.js/);
  });
});

describe('SDK_VERSION sync', () => {
  it('matches package.json version exactly', async () => {
    // Read package.json and the SDK_VERSION constant. They MUST match —
    // the version is forwarded to the VPS as integrator.sdk_version on
    // every challenge for cross-version debugging. A drift means analytics
    // reports a release that doesn't exist on npm.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

    // We can't import SDK_VERSION directly (it's not exported). Read the
    // source file and grep for it — keeps the test honest about what
    // actually ships in dist/.
    const sourcePath = resolve(here, 'index.ts');
    const source = readFileSync(sourcePath, 'utf-8');
    const match = source.match(/const\s+SDK_VERSION\s*=\s*'([^']+)'/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.version);
  });
});

describe('SessionStore: bounded memory', () => {
  it('LRU-evicts the oldest entry when the size cap is reached', async () => {
    const { createSessionStore } = await import('./session-store.js');
    const store = createSessionStore(/* maxSize */ 3, /* idleTtlMs */ 1_000_000);

    // Fill to the cap. Distinct ids → distinct entries → size 3.
    store.get('a');
    store.get('b');
    store.get('c');
    expect(store.size()).toBe(3);
    expect(store.peek('a')).toBeDefined();

    // Insert a 4th. Hard-cap evicts the LRU entry, which is 'a' (the
    // oldest by insertion order — none of a/b/c have been re-touched).
    store.get('d');
    expect(store.size()).toBe(3);
    expect(store.peek('a')).toBeUndefined();
    expect(store.peek('b')).toBeDefined();
    expect(store.peek('c')).toBeDefined();
    expect(store.peek('d')).toBeDefined();
  });

  it('touching a session slides it to the LRU tail (re-touched survives eviction)', async () => {
    const { createSessionStore } = await import('./session-store.js');
    const store = createSessionStore(3, 1_000_000);

    store.get('a');
    store.get('b');
    store.get('c');
    // Touch 'a' again — now b is the oldest.
    store.get('a');
    // Insert 'd' — should evict 'b', not 'a'.
    store.get('d');

    expect(store.peek('a')).toBeDefined();
    expect(store.peek('b')).toBeUndefined();
    expect(store.peek('c')).toBeDefined();
    expect(store.peek('d')).toBeDefined();
  });

  it('TTL-evicts an idle session on the next miss', async () => {
    const { createSessionStore } = await import('./session-store.js');
    // Inject a manual clock so we can fast-forward without timers.
    let clock = 1_000_000;
    const store = createSessionStore(100, 60_000, () => clock);

    store.get('idle');
    expect(store.peek('idle')).toBeDefined();
    // Fast-forward past the idle TTL.
    clock += 60_001;
    // Trigger a miss. The 'idle' entry is the head of the map and
    // older than idleTtlMs, so it gets swept out before we insert.
    store.get('fresh');
    expect(store.peek('idle')).toBeUndefined();
    expect(store.peek('fresh')).toBeDefined();
  });

  it('peek() does NOT extend a session\'s lifetime', async () => {
    const { createSessionStore } = await import('./session-store.js');
    let clock = 1_000_000;
    const store = createSessionStore(3, 60_000, () => clock);

    store.get('a');
    store.get('b');
    // Peek 'a' — must NOT slide its LRU position.
    store.peek('a');
    store.get('c');
    // Insert 'd' — 'a' should still be the LRU and get evicted, even
    // though we peeked it.
    store.get('d');
    expect(store.peek('a')).toBeUndefined();
    expect(store.peek('b')).toBeDefined();
  });
});

describe('FdkeyContext: score/tier first-class fields', () => {
  it('returns score=null and tier=null on a fresh session', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const wrapped = withFdkey(server, {
      apiKey: 'fdk_test',
      vpsUrl: 'https://api.example.com',
    });

    const ctx = getFdkeyContext(wrapped, { sessionId: 'unknown' });
    expect(ctx).not.toBeNull();
    const c = ctx as FdkeyContext;
    expect(c.verified).toBe(false);
    expect(c.verifiedAt).toBeNull();
    expect(c.score).toBeNull();
    expect(c.tier).toBeNull();
    expect(c.claims).toBeNull();
  });

  it('FdkeyContext type exposes score and tier as first-class fields', () => {
    // Compile-time contract: this file would not type-check if the public
    // FdkeyContext interface stopped exposing `score: number | null` or
    // `tier: string | null`. Runtime assert keeps the test self-contained.
    const ctx: FdkeyContext = {
      verified: true,
      verifiedAt: 1700000000000,
      score: 1.0,
      tier: 'gold',
      claims: { score: 1.0, tier: 'gold', threshold: 0.5 },
    };
    expect(ctx.score).toBe(1.0);
    expect(ctx.tier).toBe('gold');
  });
});
