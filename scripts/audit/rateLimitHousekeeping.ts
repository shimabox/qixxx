import { RANKING_RATE_LIMIT_RETENTION_SECONDS } from './constants';
import type { AuditD1Database } from './d1Adapter';

/** Deletes expired rate-limit rows and returns only the aggregate count. */
export async function deleteExpiredRankingRateLimits(db: AuditD1Database, now?: number): Promise<number> {
  // D1's own clock by default, like every other time comparison the audit
  // makes: the host running this job is not what wrote `updated_at`, and a
  // host clock far enough ahead would otherwise sweep live windows.
  const statement =
    now === undefined
      ? db.prepare('DELETE FROM ranking_rate_limits WHERE updated_at < unixepoch() - ?1').bind(RANKING_RATE_LIMIT_RETENTION_SECONDS)
      : db.prepare('DELETE FROM ranking_rate_limits WHERE updated_at < ?1 - ?2').bind(now, RANKING_RATE_LIMIT_RETENTION_SECONDS);
  const result = await statement.run();
  return result.meta.changes;
}
