/**
 * Bounded in-memory session store. Default impl behind
 * `FdkeyHttpConfig.sessionStore`.
 *
 * Mirrors the `@fdkey/mcp` SessionStore byte-for-byte:
 *   - 1h idle TTL (sweep-on-access).
 *   - 10k LRU hard cap (the actual memory bound).
 *   - JS Map insertion-order semantics → LRU at the head, O(1) eviction.
 *
 * Async API: integrators in multi-process deployments override with a
 * Redis-backed implementation that returns Promises naturally. The default
 * just `Promise.resolve(...)`s its returns.
 */

import type { SessionStore, VerifiedSession } from './types.js';

export const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 10_000;

interface Entry {
  session: VerifiedSession;
  /** Last touched (read or write). Drives the LRU position via re-insertion. */
  lastTouchedAt: number;
}

export interface InMemorySessionStoreOptions {
  maxSize?: number;
  idleTtlMs?: number;
  /** Test seam — inject a clock. */
  now?: () => number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxSize: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(opts: InMemorySessionStoreOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SESSIONS;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async get(sid: string): Promise<VerifiedSession | undefined> {
    const e = this.entries.get(sid);
    if (!e) return undefined;
    // Slide LRU position to tail.
    this.entries.delete(sid);
    e.lastTouchedAt = this.now();
    this.entries.set(sid, e);
    return e.session;
  }

  async set(sid: string, session: VerifiedSession): Promise<void> {
    const t = this.now();
    // If reinsert: just refresh the entry.
    const existing = this.entries.get(sid);
    if (existing) {
      this.entries.delete(sid);
      this.entries.set(sid, { session, lastTouchedAt: t });
      return;
    }
    // New entry: opportunistic TTL sweep + LRU cap enforcement.
    this.evictIfNeeded(t);
    this.entries.set(sid, { session, lastTouchedAt: t });
  }

  async delete(sid: string): Promise<boolean> {
    return this.entries.delete(sid);
  }

  /** Inspect-only — used by tests and instrumentation. */
  size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(t: number): void {
    // TTL: drop the head if it's stale. O(1) per call.
    const headKey = this.entries.keys().next().value;
    if (headKey !== undefined) {
      const head = this.entries.get(headKey);
      if (head && t - head.lastTouchedAt > this.idleTtlMs) {
        this.entries.delete(headKey);
      }
    }
    // Hard cap: drop the LRU regardless of age.
    if (this.entries.size >= this.maxSize) {
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) this.entries.delete(lruKey);
    }
  }
}
