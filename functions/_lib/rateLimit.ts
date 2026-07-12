// Per-IP rate limiting for POST /share (docs/plan-cloudflare-x-share.md
// Phase 2: "IP ごとに 1 時間 30 回まで（KV カウンタ、TTL 1h）"). A simple
// fixed-window counter: the window boundary is baked into the KV key itself
// (kv.ts's rateLimitKey), so this is just a get-check-put — no separate
// reset/cleanup logic, and the entry's own TTL (windowSeconds) is what
// reclaims it once the window has fully elapsed. KV's read-then-write isn't
// atomic, so a burst of near-simultaneous requests from the same IP could
// slightly overshoot the cap under a race — acceptable for an abuse
// deterrent (not a hard security boundary; see share.ts's Origin check and
// scoreLimits.ts's theoretical-max check for the checks that actually matter
// for integrity).
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS, rateLimitKey } from './kv';

/**
 * Returns true (and records the hit) if `ip` is still under the limit for
 * its current window; false if the limit has already been reached (caller
 * should respond 429 and must NOT record anything further).
 */
export async function consumeRateLimit(
  kv: KVNamespace,
  ip: string,
  now: number = Date.now()
): Promise<boolean> {
  const key = rateLimitKey(ip, now);
  const current = await kv.get(key);
  const count = current === null ? 0 : parseInt(current, 10);

  if (Number.isNaN(count) || count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}
