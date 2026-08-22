import { RANKING_RATE_LIMIT_RETENTION_SECONDS } from './constants';

/** Deletes expired rate-limit rows and returns only the aggregate count. */
export async function deleteExpiredRankingRateLimits(db: D1Database): Promise<number> {
  const result = await db
    .prepare('DELETE FROM ranking_rate_limits WHERE updated_at < unixepoch() - ?1')
    .bind(RANKING_RATE_LIMIT_RETENTION_SECONDS)
    .run();
  return result.meta.changes;
}
