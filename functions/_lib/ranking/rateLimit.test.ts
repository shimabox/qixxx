import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { consumeRankingRateLimit, RANKING_RATE_LIMIT_UPSERT_SQL } from './rateLimit';

describe('consumeRankingRateLimit (real local D1)', () => {
  let testD1: TestD1;

  beforeAll(async () => {
    testD1 = await createTestD1();
  }, 30_000);

  beforeEach(async () => {
    await testD1.db.prepare('DELETE FROM ranking_rate_limits').run();
  });

  afterAll(async () => {
    await testD1?.dispose();
  });

  it('reports changes=0 through a rejected 31st call', async () => {
    const now = 1_800_000;
    for (let request = 1; request <= 30; request++) {
      await expect(consumeRankingRateLimit(testD1.db, 'hash-a', now)).resolves.toMatchObject({ allowed: true });
    }

    const rejected = await testD1.db.prepare(RANKING_RATE_LIMIT_UPSERT_SQL).bind('hash-a', 0, 1800, 30).run();
    expect(rejected.meta.changes).toBe(0);
    const row = await testD1.db.prepare('SELECT request_count FROM ranking_rate_limits WHERE ip_hash = ?1').bind('hash-a').first<{ request_count: number }>();
    expect(row?.request_count).toBe(30);
  });

  it('atomically allows exactly 30 of 31 concurrent calls for one hash', async () => {
    const results = await Promise.all(Array.from({ length: 31 }, () => consumeRankingRateLimit(testD1.db, 'hash-concurrent', 1_800_000)));
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);

    const rows = await testD1.db.prepare('SELECT ip_hash, request_count FROM ranking_rate_limits').all<{ ip_hash: string; request_count: number }>();
    expect(rows.results).toEqual([{ ip_hash: 'hash-concurrent', request_count: 30 }]);
  });

  it('keeps hashes independent and resets the same row in the next window', async () => {
    const endOfWindow = 3_599_999;
    for (let request = 1; request <= 30; request++) {
      expect((await consumeRankingRateLimit(testD1.db, 'hash-a', endOfWindow)).allowed).toBe(true);
    }
    expect(await consumeRankingRateLimit(testD1.db, 'hash-a', endOfWindow)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect((await consumeRankingRateLimit(testD1.db, 'hash-b', endOfWindow)).allowed).toBe(true);
    expect(await consumeRankingRateLimit(testD1.db, 'hash-a', 3_600_000)).toEqual({ allowed: true, retryAfterSeconds: 3600 });

    const rows = await testD1.db.prepare('SELECT ip_hash, window_index, request_count, updated_at FROM ranking_rate_limits ORDER BY ip_hash').all<{
      ip_hash: string;
      window_index: number;
      request_count: number;
      updated_at: number;
    }>();
    expect(rows.results).toEqual([
      { ip_hash: 'hash-a', window_index: 1, request_count: 1, updated_at: 3600 },
      { ip_hash: 'hash-b', window_index: 0, request_count: 1, updated_at: 3599 },
    ]);
  });

  it('does not treat an unexpected changes value as allowed', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 2 } }) }),
      }),
    } as unknown as D1Database;
    await expect(consumeRankingRateLimit(db, 'hash-unexpected', 0)).resolves.toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });
});
