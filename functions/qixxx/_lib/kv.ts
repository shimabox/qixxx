// KV key layout and TTLs for the single `SHARES` namespace
// (docs/plan-cloudflare-x-share.md Phase 2). Two unrelated things share this
// one namespace (share records and rate-limit counters), so both key
// builders below prefix their keys to keep them from ever colliding.

/** Share records are stored 180 days (docs/plan-cloudflare-x-share.md Phase 2). */
export const SHARE_RECORD_TTL_SECONDS = 60 * 60 * 24 * 180;

/** Key for a share record (functions/qixxx/_lib/types.ts's ShareRecord). */
export function shareRecordKey(id: string): string {
  return `share:${id}`;
}

/** Rate limit: 30 requests/hour per IP (docs/plan-cloudflare-x-share.md Phase 2). */
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

/**
 * Key for an IP's rate-limit counter in the current fixed window. The
 * window index (epoch-hour, when windowSeconds is the default 3600) is
 * baked into the key itself, so the counter for a past window is simply a
 * different (and, thanks to the KV entry's own `expirationTtl`, self
 * -expiring) key rather than something this code has to reset by hand — a
 * fixed-window limiter rather than a sliding one, which is a deliberate
 * simplification (see rateLimit.ts's module comment).
 */
export function rateLimitKey(ip: string, now: number, windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS): string {
  const windowIndex = Math.floor(now / (windowSeconds * 1000));
  return `ratelimit:${ip}:${windowIndex}`;
}
