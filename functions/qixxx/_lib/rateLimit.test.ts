import { describe, it, expect } from 'vitest';
import { consumeRateLimit } from './rateLimit';
import { RATE_LIMIT_MAX_REQUESTS } from './kv';

// Minimal in-memory stand-in for the one KVNamespace surface consumeRateLimit
// actually uses (get/put) — a full KVNamespace mock would need to implement
// getWithMetadata/list/delete/etc. that this code never calls.
function makeFakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

describe('consumeRateLimit', () => {
  it('allows requests under the limit', async () => {
    const kv = makeFakeKv();
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(await consumeRateLimit(kv, '1.2.3.4', now)).toBe(true);
    }
  });

  it('rejects the request once the limit is reached within the same window', async () => {
    const kv = makeFakeKv();
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      await consumeRateLimit(kv, '1.2.3.4', now);
    }
    expect(await consumeRateLimit(kv, '1.2.3.4', now)).toBe(false);
  });

  it('tracks each IP independently', async () => {
    const kv = makeFakeKv();
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      await consumeRateLimit(kv, '1.1.1.1', now);
    }
    expect(await consumeRateLimit(kv, '1.1.1.1', now)).toBe(false);
    expect(await consumeRateLimit(kv, '2.2.2.2', now)).toBe(true);
  });

  it('resets in a new time window (fixed-window counter)', async () => {
    const kv = makeFakeKv();
    const windowMs = 60 * 60 * 1000;
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      await consumeRateLimit(kv, '3.3.3.3', now);
    }
    expect(await consumeRateLimit(kv, '3.3.3.3', now)).toBe(false);
    expect(await consumeRateLimit(kv, '3.3.3.3', now + windowMs)).toBe(true);
  });
});
