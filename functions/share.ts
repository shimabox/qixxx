// POST /share (docs/plan-cloudflare-x-share.md Phase 2): issues an
// unguessable share ID for {score, stage, hi} after the request passes the
// Origin check, the per-client rate limit, the theoretical score ceiling,
// and the body-shape checks — then stores the record in KV (`SHARES`) for
// 180 days and returns { id }.
//
// Check order matters for cost: everything that needs only headers runs
// first, the rate limit is consumed BEFORE the body is read, and the body is
// read through a byte-capped stream — so a client sending oversized or
// malformed bodies still burns its own rate-limit budget and can never make
// this Worker buffer more than MAX_BODY_BYTES. The same ordering POST
// /api/scores uses (functions/api/scores.ts).
import type { Env, ShareRecord } from './_lib/types';
import { validateSharePayload } from './_lib/validation';
import { generateShareId } from './_lib/shareId';
import { consumeRateLimit } from './_lib/rateLimit';
import { shareRecordKey, SHARE_RECORD_TTL_SECONDS } from './_lib/kv';
import { jsonResponse } from './_lib/response';
import { readBodyWithLimit } from './_lib/readBody';
import { requireIpHashKey, computeIpHash, normalizeClientIp, MissingIpHashKeyError } from './_lib/ranking/ipHash';

/**
 * Hard cap on the request body. The payload is three small integers
 * (`{"score":…,"stage":…,"hi":…}`, well under 100 bytes); 1 KiB leaves room
 * for whitespace and still rejects anything that isn't this payload.
 */
export const MAX_BODY_BYTES = 1024;

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

  // 2. Header-only body checks — cheap early-outs for honest clients. The
  // Content-Length one is advisory (a client can omit or lie about it); the
  // byte-capped read below is the check that actually holds.
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: 'unsupported content-type' }, 415);
  }
  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader !== null && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'request body too large' }, 413);
  }

  // 3. Rate limit (docs/plan-cloudflare-x-share.md Phase 2): 30/hour per
  // client. Keyed on the client's ip_hash — HMAC of the /64-normalized
  // address — so the KV counter never stores a raw IP (the same rule the D1
  // ranking tables follow) and one IPv6 subscriber rotating addresses can't
  // sidestep the limit. Fail-closed on a missing key, like /api/scores.
  let ipHashKey: string;
  try {
    ipHashKey = requireIpHashKey(env.RANKING_IP_HASH_KEY);
  } catch (err) {
    if (err instanceof MissingIpHashKeyError) {
      console.error('POST /share: RANKING_IP_HASH_KEY is not configured');
      return jsonResponse({ error: 'internal error' }, 500);
    }
    throw err;
  }
  const ip = normalizeClientIp(request.headers.get('CF-Connecting-IP') ?? 'unknown');
  const clientKey = await computeIpHash(ip, ipHashKey);
  const allowed = await consumeRateLimit(env.SHARES, clientKey);
  if (!allowed) {
    return jsonResponse({ error: 'rate limit exceeded' }, 429);
  }

  // 4. Body: streaming, byte-counted read, then parse + shape/ceiling checks.
  const bodyRead = await readBodyWithLimit(request.body, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too-large'
      ? jsonResponse({ error: 'request body too large' }, 413)
      : jsonResponse({ error: 'failed to read request body' }, 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyRead.text);
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

  const id = generateShareId();
  const record: ShareRecord = { ...result.value, at: Date.now() };
  await env.SHARES.put(shareRecordKey(id), JSON.stringify(record), {
    expirationTtl: SHARE_RECORD_TTL_SECONDS,
  });

  return jsonResponse({ id }, 200);
};
