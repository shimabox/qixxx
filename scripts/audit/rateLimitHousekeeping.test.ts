import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_D1_BIND_MODES, auditDatabaseWithBindMode, createTestD1, seedScoreRow, type TestD1 } from './testSupport/localD1';
import type { AuditD1Database } from './d1Adapter';
import { deleteExpiredRankingRateLimits } from './rateLimitHousekeeping';
import { RANKING_RATE_LIMIT_RETENTION_SECONDS } from './constants';

describe.each(AUDIT_D1_BIND_MODES)('rate-limit housekeeping (real local D1, %s binds)', (bindMode) => {
  let testD1: TestD1;
  let auditDb: AuditD1Database;

  beforeAll(async () => {
    testD1 = await createTestD1();
    auditDb = auditDatabaseWithBindMode(testD1.db, bindMode);
  }, 30_000);

  beforeEach(async () => {
    await testD1.db.prepare('DELETE FROM ranking_rate_limits').run();
    await testD1.db.prepare('DELETE FROM scores').run();
  });

  afterAll(async () => {
    await testD1?.dispose();
  });

  it('deletes only rows older than 24 hours and leaves score data unchanged', async () => {
    const now = 1_800_000_000;
    await seedScoreRow(testD1.db, { id: 'score-preserved', replay_hash: 'score-preserved-hash' });
    await testD1.db
      .prepare(
        `INSERT INTO ranking_rate_limits (ip_hash, window_index, request_count, updated_at)
         VALUES ('expired-a', 1, 3, ?1 - ?2 - 1),
                ('expired-b', 1, 4, ?1 - ?2 - 100),
                ('boundary', 1, 5, ?1 - ?2),
                ('current', 2, 6, ?1)`
      )
      .bind(now, RANKING_RATE_LIMIT_RETENTION_SECONDS)
      .run();

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deleteExpiredRankingRateLimits(auditDb, now)).resolves.toBe(2);
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
