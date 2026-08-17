// Per-IP rate limiting for POST /api/scores (docs/plans/2026-08-16-score-
// ranking task 3: "レート制限はランキング専用の KV キーを用い、厳しめの回数
// に設定する"). Reuses the existing `SHARES` KV binding (a *dedicated key
// prefix* is what the spec calls for, not a dedicated namespace) rather than
// functions/_lib/rateLimit.ts's share-feature constants/keys, since a
// resimulation-backed POST is far more expensive per request than a share
// mint and deserves its own, much stricter budget.
//
// Same non-atomic caveat as the share feature's rate limiter (functions/_lib/
// rateLimit.ts's own module comment): KV's read-then-write isn't atomic, so
// a burst of near-simultaneous requests from the same IP could slightly
// overshoot this cap under a race. Acceptable here for the same reason it's
// acceptable there — this is an abuse deterrent, not the integrity boundary
// (verifyReplay.ts's resimulation is what actually decides a submission's
// score; a handful of extra POSTs at worst costs a little extra CPU, it can
// never inflate a score).
const RANKING_RATE_LIMIT_MAX_REQUESTS = 10;
const RANKING_RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

export function rankingRateLimitKey(ip: string, now: number, windowSeconds: number = RANKING_RATE_LIMIT_WINDOW_SECONDS): string {
  const windowIndex = Math.floor(now / (windowSeconds * 1000));
  return `ranking-post-ratelimit:${ip}:${windowIndex}`;
}

/** Returns true (and records the hit) if `ip` is still under the limit for its current window; false if the limit has already been reached. */
export async function consumeRankingRateLimit(kv: KVNamespace, ip: string, now: number = Date.now()): Promise<boolean> {
  const key = rankingRateLimitKey(ip, now);
  const current = await kv.get(key);
  const count = current === null ? 0 : parseInt(current, 10);

  if (Number.isNaN(count) || count >= RANKING_RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  await kv.put(key, String(count + 1), { expirationTtl: RANKING_RATE_LIMIT_WINDOW_SECONDS });
  return true;
}
