const RANKING_RATE_LIMIT_MAX_REQUESTS = 30;
const RANKING_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export const RANKING_RATE_LIMIT_UPSERT_SQL = `INSERT INTO ranking_rate_limits (ip_hash, window_index, request_count, updated_at)
VALUES (?1, ?2, 1, ?3)
ON CONFLICT(ip_hash) DO UPDATE SET
  window_index = excluded.window_index,
  request_count = CASE
    WHEN ranking_rate_limits.window_index = excluded.window_index
      THEN ranking_rate_limits.request_count + 1
    ELSE 1
  END,
  updated_at = excluded.updated_at
WHERE ranking_rate_limits.window_index <> excluded.window_index
   OR ranking_rate_limits.request_count < ?4`;

export interface RankingRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Atomically consumes one request from an IP hash's fixed-window allowance. */
export async function consumeRankingRateLimit(db: D1Database, ipHash: string, now: number = Date.now()): Promise<RankingRateLimitResult> {
  const windowIndex = Math.floor(now / RANKING_RATE_LIMIT_WINDOW_MS);
  const updatedAt = Math.floor(now / 1000);
  const result = await db
    .prepare(RANKING_RATE_LIMIT_UPSERT_SQL)
    .bind(ipHash, windowIndex, updatedAt, RANKING_RATE_LIMIT_MAX_REQUESTS)
    .run();

  const retryAfterSeconds = Math.max(1, Math.ceil(((windowIndex + 1) * RANKING_RATE_LIMIT_WINDOW_MS - now) / 1000));
  return {
    allowed: result.meta.changes === 1,
    retryAfterSeconds,
  };
}
