import { RANKING_RATE_LIMIT_RETENTION_SECONDS } from './constants';
import type { AuditD1Database } from './d1Adapter';

/** Deletes expired rate-limit rows and returns only the aggregate count. */
export async function deleteExpiredRankingRateLimits(
  db: AuditD1Database,
  now: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM ranking_rate_limits WHERE updated_at < ?1 - ?2')
    .bind(now, RANKING_RATE_LIMIT_RETENTION_SECONDS)
    .run();
  return result.meta.changes;
}
