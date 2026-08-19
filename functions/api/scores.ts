// POST /api/scores — Free-tier async-audit version (docs/plans/2026-08-19-
// ranking-free-async task 4). Unlike the Paid/synchronous-verification
// version this branch forks from (plan/2026-08-16-score-ranking), this
// handler NEVER calls verifyReplay() (no resimulation): Cloudflare Free's
// 10ms-CPU-per-request ceiling can't afford it (see this feature's
// request.md background). Instead:
//   - the client's score/stage claim is taken at face value structurally
//     (an integer in-range) but NOT trusted for ranking correctness yet;
//   - duration_ticks is derived server-side from an RLE DECODE-ONLY pass
//     (functions/_lib/ranking/rleDuration.ts) — never a full resimulation;
//   - a submission that can't possibly make the confirmed TOP10 is rejected
//     immediately without ever being stored (the pre-pending gate);
//   - everything that passes is stored as `status='pending'` and returned
//     as "provisionally accepted, verification pending" — a separate,
//     asynchronous audit job (scripts/audit/) is what actually calls
//     verifyReplay() (via verifyPendingEntry()) later and either confirms
//     (`status='verified'`) or deletes the row.
import type { Env } from '../_lib/types';
import { jsonResponse } from '../_lib/response';
import { generateShareId } from '../_lib/shareId';
import { computeReplayHash } from '../_lib/ranking/hash';
import { validateName, validateXHandle } from '../_lib/ranking/nameValidation';
import { validateSeed } from '../_lib/ranking/seedValidation';
import { validateScore, validateStage } from '../_lib/ranking/scoreValidation';
import { deriveDurationTicksFromRle } from '../_lib/ranking/rleDuration';
import { getVerifiedTenthPlaceThreshold, isWithinProvisionalRange, PENDING_EXPIRY_MS } from '../_lib/ranking/pendingGate';
import { requireIpHashKey, computeIpHash, MissingIpHashKeyError } from '../_lib/ranking/ipHash';
import { consumeRankingRateLimit } from '../_lib/ranking/rateLimit';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../_lib/ranking/season';
import { RleDecodeError } from '../../src/core/rle';
import type { ScoreSubmission } from '../_lib/ranking/types';

// Body size cap (docs/plans/2026-08-16-score-ranking task 3's "body サイズ"
// check, unchanged by this round): base64-encoded RLE for a 10800-sample
// worst-case replay is at most a few tens of KB in practice — 256 KiB leaves
// generous headroom for the base64 + JSON-object overhead without coming
// anywhere near D1's own 2 MB per-BLOB ceiling.
const MAX_BODY_BYTES = 256 * 1024;

// Pending-submission caps (docs/plans/2026-08-19-ranking-free-async spec
// item 7): enforced atomically inside the INSERT...SELECT below, never as a
// separate read-then-write.
const MAX_GLOBAL_PENDING = 200;
const MAX_PENDING_PER_IP = 3;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What readBodyWithLimit() decided about the request body. */
export type BodyReadResult = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'read-failed' };

/**
 * Reads the request body while counting bytes, aborting the moment the cap
 * is passed.
 *
 * Deliberately NOT `await request.text()` followed by a length check: that
 * buffers the entire body first, so a client that omits or lies about
 * Content-Length can make this public endpoint materialize up to Cloudflare's
 * 100 MB request ceiling inside a Worker with a 128 MB memory limit — an
 * out-of-memory DoS reachable before a single validation runs. The
 * Content-Length pre-check in the handler is only a cheap early-out for
 * honest clients; this is the check that actually holds.
 *
 * Cancels the stream on overflow rather than draining it, so an abusive
 * upload stops costing us anything as soon as it is recognized.
 */
export async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<BodyReadResult> {
  if (body === null) return { ok: true, text: '' };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too-large' };
      }
      // `stream: true` so a multi-byte UTF-8 sequence split across chunk
      // boundaries is carried over rather than turned into replacement
      // characters.
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: 'read-failed' };
  }
}

/**
 * True only for a D1/SQLite UNIQUE-constraint failure — here, always the
 * `replay_hash` index (migrations/0001_create_scores.sql), i.e. a genuine
 * re-submission of an already-ranked (or already-pending) replay.
 *
 * Matched on the message because D1 surfaces SQLite errors as plain `Error`s
 * without a structured code. Kept deliberately narrow: anything unrecognized
 * falls through to a 500 rather than being optimistically called a duplicate.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Pre-storage checks (cheapest-first, so an abusive/malformed request
  // never reaches D1 at all).
  const origin = request.headers.get('Origin');
  const selfOrigin = new URL(request.url).origin;
  if (origin === null || origin !== selfOrigin) {
    return jsonResponse({ error: 'forbidden: origin mismatch' }, 403);
  }

  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: 'unsupported content-type' }, 415);
  }

  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader !== null && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'request body too large' }, 413);
  }

  // ip_hash key check (docs/plans/2026-08-19-ranking-free-async spec item 7):
  // fail closed at the entrypoint, before any D1/KV operation — Pages
  // Functions has no build-time-guaranteed "secret is bound" phase to hook
  // this into instead. No raw-IP fallback exists; a missing key is always a
  // hard failure, never a degraded-but-working path.
  let ipHashKey: string;
  try {
    ipHashKey = requireIpHashKey(env.RANKING_IP_HASH_KEY);
  } catch (err) {
    if (err instanceof MissingIpHashKeyError) {
      console.error('POST /api/scores: RANKING_IP_HASH_KEY is not configured');
      return jsonResponse({ error: 'internal error', accepted: false }, 500);
    }
    throw err;
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  // Non-atomic KV read-then-write (functions/_lib/ranking/rateLimit.ts's own
  // module comment documents this — an abuse deterrent, not the integrity
  // boundary; the pending-cap INSERT below is what actually holds the line
  // atomically).
  const allowed = await consumeRankingRateLimit(env.SHARES, ip);
  if (!allowed) {
    return jsonResponse({ error: 'rate limit exceeded' }, 429);
  }

  // Streaming, byte-counted read — see readBodyWithLimit()'s doc comment for
  // why the buffer-then-measure form was a memory-DoS hole.
  const bodyRead = await readBodyWithLimit(request.body, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too-large'
      ? jsonResponse({ error: 'request body too large' }, 413)
      : jsonResponse({ error: 'failed to read request body' }, 400);
  }
  const rawBody = bodyRead.text;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'body must be a JSON object' }, 400);
  }
  const submission = body as Partial<ScoreSubmission>;

  // A uint32 check, not merely "a finite number" — the client's only seed
  // source is crypto.getRandomValues(new Uint32Array(1)) (src/main.ts's
  // generateNormalRunSeed()), so anything else was never a real run's seed.
  // See seedValidation.ts's module comment.
  const seedResult = validateSeed(submission.seed);
  if (!seedResult.ok) {
    return jsonResponse({ error: seedResult.reason }, 400);
  }
  const seed = seedResult.value;

  if (typeof submission.rleBase64 !== 'string' || submission.rleBase64.length === 0) {
    return jsonResponse({ error: 'rleBase64 must be a non-empty string' }, 400);
  }
  if (typeof submission.rulesetVersion !== 'number' || typeof submission.replayFormatVersion !== 'number') {
    return jsonResponse({ error: 'rulesetVersion/replayFormatVersion must be numbers' }, 400);
  }

  // Version check: reject before ever storing a replay recorded under a
  // build this server no longer agrees with (a stale cached client bundle,
  // most commonly) — unchanged from the Paid version's own check.
  if (submission.rulesetVersion !== RULESET_VERSION || submission.replayFormatVersion !== REPLAY_FORMAT_VERSION) {
    return jsonResponse({ error: 'ruleset_version/replay_format_version mismatch', accepted: false }, 409);
  }

  const nameResult = validateName(submission.name);
  if (!nameResult.ok) {
    return jsonResponse({ error: nameResult.reason }, 400);
  }
  const xHandleResult = validateXHandle(submission.xHandle);
  if (!xHandleResult.ok) {
    return jsonResponse({ error: xHandleResult.reason }, 400);
  }
  if (nameResult.value === '' && xHandleResult.value === null) {
    return jsonResponse({ error: 'either name or xHandle is required' }, 400);
  }

  // score/stage: the client's claim (docs/plans/2026-08-19-ranking-free-async
  // spec item 1) — structurally validated here, but NOT trusted for ranking
  // correctness until the async audit's verifyPendingEntry() confirms it
  // against a real resimulation.
  const scoreResult = validateScore(submission.score);
  if (!scoreResult.ok) {
    return jsonResponse({ error: scoreResult.reason }, 400);
  }
  const stageResult = validateStage(submission.stage);
  if (!stageResult.ok) {
    return jsonResponse({ error: stageResult.reason }, 400);
  }
  const score = scoreResult.value;
  const stage = stageResult.value;

  let rle: Uint8Array;
  try {
    rle = base64ToBytes(submission.rleBase64);
  } catch {
    return jsonResponse({ error: 'rleBase64 is not valid base64' }, 400);
  }

  // duration_ticks: derived server-side from an RLE DECODE-ONLY pass — never
  // a client claim, never a resimulation (docs/plans/2026-08-19-ranking-
  // free-async spec item 1 / functions/_lib/ranking/rleDuration.ts's own doc
  // comment on why this keeps the "verifyReplay() is never invoked from
  // POST" structural guarantee intact).
  let durationTicks: number;
  try {
    durationTicks = deriveDurationTicksFromRle(rle);
  } catch (err) {
    if (err instanceof RleDecodeError) {
      return jsonResponse({ error: 'malformed replay data', accepted: false }, 400);
    }
    throw err;
  }

  // 2. Pre-pending gate (spec item 2): a submission that cannot possibly
  // make the confirmed TOP10 is never stored as pending at all — saves a
  // pending slot for something that has a real shot, and gives an honest
  // "not accepted" answer immediately rather than a false "pending" one that
  // the audit would only delete later for being out of range. Non-atomic
  // SELECT is fine here (spec item 2: this is a UX nicety, not the integrity
  // boundary — the boundary is the atomic INSERT below).
  const threshold = await getVerifiedTenthPlaceThreshold(env, CURRENT_SEASON_ID, RULESET_VERSION);
  if (!isWithinProvisionalRange(score, threshold)) {
    return jsonResponse(
      {
        accepted: false,
        reason: 'out-of-range',
        message: 'this score is not currently within contention for the top 10 and was not saved',
      },
      200
    );
  }

  const replayHash = await computeReplayHash({
    seasonId: CURRENT_SEASON_ID,
    rulesetVersion: RULESET_VERSION,
    seed,
    rle,
  });

  const id = generateShareId();
  const createdAt = Date.now();
  const ipHash = await computeIpHash(ip, ipHashKey);
  const expiryCutoff = createdAt - PENDING_EXPIRY_MS;

  // 3. Atomic pending-cap INSERT (spec item 7's confirmed design): a single
  // INSERT...SELECT...WHERE statement, so the two COUNT(*) checks and the
  // row insertion are evaluated together — a concurrent POST cannot slip
  // past the cap the way a separate "SELECT COUNT then INSERT" round trip
  // could. `changes === 0` afterward means the WHERE clause's conditions
  // failed (cap reached), NOT a UNIQUE violation (which throws instead — see
  // the catch block below). Expired (>24h old) pending rows are excluded
  // from both COUNT(*)s (spec item 7's "監査停止時の保護") so a stalled
  // audit job can't leave stale pending rows permanently blocking new
  // submissions.
  let insertResult;
  try {
    insertResult = await env.DB.prepare(
      `INSERT INTO scores
         (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending', ?14, 0, NULL
       WHERE (SELECT COUNT(*) FROM scores WHERE status = 'pending' AND created_at > ?15) < ?16
         AND (SELECT COUNT(*) FROM scores WHERE status = 'pending' AND ip_hash = ?14 AND created_at > ?15) < ?17`
    )
      .bind(
        id,
        CURRENT_SEASON_ID,
        RULESET_VERSION,
        REPLAY_FORMAT_VERSION,
        score,
        stage,
        nameResult.value,
        xHandleResult.value,
        seed,
        rle,
        durationTicks,
        replayHash,
        createdAt,
        ipHash,
        expiryCutoff,
        MAX_GLOBAL_PENDING,
        MAX_PENDING_PER_IP
      )
      .run();
  } catch (err) {
    // Only a UNIQUE violation means "this exact replay was already
    // submitted (pending or verified)". Everything else — an unapplied
    // migration, a missing/misconfigured DB binding, a D1 outage — is a
    // server fault, and reporting it as 409 "duplicate replay" both lies to
    // the client and hides a real operational problem behind a
    // success-adjacent status.
    if (isUniqueConstraintViolation(err)) {
      return jsonResponse({ error: 'duplicate replay', accepted: false }, 409);
    }
    // Logged server-side (visible in `wrangler tail` / the Cloudflare
    // dashboard) but never echoed back: the raw D1 message carries table and
    // column names, and this is an unauthenticated public endpoint.
    console.error('POST /api/scores: D1 insert failed', err);
    return jsonResponse({ error: 'internal error', accepted: false }, 500);
  }

  if (insertResult.meta.changes === 0) {
    // Cap reached (global 200 or this IP's 3) — existing pending rows are
    // NOT deleted to make room (spec item 7's confirmed "既存 pending を削除
    // せず429").
    return jsonResponse({ error: 'pending submission limit reached, try again later', accepted: false }, 429);
  }

  return jsonResponse(
    {
      accepted: true,
      id,
      status: 'pending',
      message: 'provisionally accepted — pending verification',
      score,
      stage,
      durationTicks,
    },
    200
  );
};
