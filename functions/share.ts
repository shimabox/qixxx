// POST /share (docs/plan-cloudflare-x-share.md Phase 2): issues an
// unguessable share ID for {score, stage, hi} after three checks — Origin,
// theoretical score ceiling, and per-IP rate limit — then stores the record
// in KV (`SHARES`) for 180 days and returns { id }.
import type { Env, ShareRecord } from './_lib/types';
import { validateSharePayload } from './_lib/validation';
import { generateShareId } from './_lib/shareId';
import { consumeRateLimit } from './_lib/rateLimit';
import { shareRecordKey, SHARE_RECORD_TTL_SECONDS } from './_lib/kv';
import { jsonResponse } from './_lib/response';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Origin check (docs/plan-cloudflare-x-share.md Phase 2): the request's
  // own Origin header must match the request URL's own origin. This one
  // check works identically in production (https://qixxx.orukubami.sh) and
  // under `wrangler pages dev` (http://localhost:8788) with zero
  // environment-specific configuration, since it never hardcodes a domain —
  // it only rejects requests whose Origin doesn't match wherever this
  // Function itself is being served from. A same-origin `fetch()` from the
  // game page always sends a matching Origin header; a bare curl or a
  // request forged from another site does not (or sends none at all, which
  // this also rejects).
  const origin = request.headers.get('Origin');
  const selfOrigin = new URL(request.url).origin;
  if (origin === null || origin !== selfOrigin) {
    return jsonResponse({ error: 'forbidden: origin mismatch' }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const result = validateSharePayload(body);
  if (result.kind === 'malformed') {
    return jsonResponse({ error: result.reason }, 400);
  }
  if (result.kind === 'exceeds-max') {
    return jsonResponse({ error: result.reason }, 422);
  }

  // 3. Rate limit (docs/plan-cloudflare-x-share.md Phase 2): 30/hour/IP.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const allowed = await consumeRateLimit(env.SHARES, ip);
  if (!allowed) {
    return jsonResponse({ error: 'rate limit exceeded' }, 429);
  }

  const id = generateShareId();
  const record: ShareRecord = { ...result.value, at: Date.now() };
  await env.SHARES.put(shareRecordKey(id), JSON.stringify(record), {
    expirationTtl: SHARE_RECORD_TTL_SECONDS,
  });

  return jsonResponse({ id }, 200);
};
