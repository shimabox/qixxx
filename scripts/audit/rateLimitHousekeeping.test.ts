import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from './testSupport/localD1';
import { deleteExpiredRankingRateLimits } from './rateLimitHousekeeping';
import { RANKING_RATE_LIMIT_RETENTION_SECONDS } from './constants';

describe('rate-limit housekeeping (real local D1)', () => {
  let testD1: TestD1;

  beforeAll(async () => {
    testD1 = await createTestD1();
  }, 30_000);

  beforeEach(async () => {
    await testD1.db.prepare('DELETE FROM ranking_rate_limits').run();
    await testD1.db.prepare('DELETE FROM scores').run();
  });

  afterAll(async () => {
    await testD1?.dispose();
  });

  it('deletes only rows older than 24 hours and leaves score data unchanged', async () => {
    await seedScoreRow(testD1.db, { id: 'score-preserved', replay_hash: 'score-preserved-hash' });
    await testD1.db
      .prepare(
        `INSERT INTO ranking_rate_limits (ip_hash, window_index, request_count, updated_at)
         VALUES ('expired-a', 1, 3, unixepoch() - ?1 - 1),
                ('expired-b', 1, 4, unixepoch() - ?1 - 100),
                ('boundary', 1, 5, unixepoch() - ?1),
                ('current', 2, 6, unixepoch())`
      )
      .bind(RANKING_RATE_LIMIT_RETENTION_SECONDS)
      .run();

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deleteExpiredRankingRateLimits(testD1.db)).resolves.toBe(2);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    const remaining = await testD1.db.prepare('SELECT ip_hash, request_count FROM ranking_rate_limits ORDER BY ip_hash').all<{
      ip_hash: string;
      request_count: number;
    }>();
    expect(remaining.results).toEqual([
      { ip_hash: 'boundary', request_count: 5 },
      { ip_hash: 'current', request_count: 6 },
    ]);
    const score = await testD1.db.prepare("SELECT id, replay_hash FROM scores WHERE id = 'score-preserved'").first();
    expect(score).toEqual({ id: 'score-preserved', replay_hash: 'score-preserved-hash' });
  });
});
