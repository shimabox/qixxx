// POST /api/scores (docs/plans/2026-08-16-score-ranking task 3): submits a
// (seed, input replay) pair for ranking. The client never claims its own
// score — verifyReplay() re-derives score/stage/duration_ticks from the
// replay itself, so a forged POST body can only ever describe a run that,
// when resimulated, produces a worse (or invalid) result than what actually
// happened, never a better one.
import type { Env } from '../_lib/types';
import { jsonResponse } from '../_lib/response';
import { generateShareId } from '../_lib/shareId';
import { verifyReplay } from '../_lib/ranking/verifyReplay';
import { computeReplayHash } from '../_lib/ranking/hash';
import { validateName, validateXHandle } from '../_lib/ranking/nameValidation';
import { validateSeed } from '../_lib/ranking/seedValidation';
import { consumeRankingRateLimit } from '../_lib/ranking/rateLimit';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../_lib/ranking/season';
import type { ScoreSubmission } from '../_lib/ranking/types';

// Body size cap (docs/plans/2026-08-16-score-ranking task 3's "body サイズ"
// check): base64-encoded RLE for a 10800-sample worst-case replay is at most
// a few tens of KB in practice (see task 7's BLOB size estimate) — 256 KiB
// leaves generous headroom for the base64 + JSON-object overhead without
// coming anywhere near D1's own 2 MB per-BLOB ceiling.
const MAX_BODY_BYTES = 256 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Pre-simulation checks (docs/plans/2026-08-16-score-ranking task 3:
  // "シミュレーション前に Origin / Content-Type / body サイズ / IP レート
  // 制限を検査する") — cheapest-first, so an abusive/malformed request never
  // reaches the expensive resimulation step below.
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

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  // Non-atomic KV read-then-write (functions/_lib/ranking/rateLimit.ts's own
  // module comment documents this — an abuse deterrent, not the integrity
  // boundary; verifyReplay()'s resimulation is what actually decides score).
  const allowed = await consumeRankingRateLimit(env.SHARES, ip);
  if (!allowed) {
    return jsonResponse({ error: 'rate limit exceeded' }, 429);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: 'failed to read request body' }, 400);
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'request body too large' }, 413);
  }

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

  // 4. Version check (docs/plans/2026-08-16-score-ranking task 3): reject
  // before ever resimulating a replay recorded under a build this server no
  // longer agrees with (a stale cached client bundle, most commonly).
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

  let rle: Uint8Array;
  try {
    rle = base64ToBytes(submission.rleBase64);
  } catch {
    return jsonResponse({ error: 'rleBase64 is not valid base64' }, 400);
  }

  // 2. Server-side resimulation (docs/plans/2026-08-16-score-ranking task 3:
  // "verifyReplay() によるサーバー側の再シミュレーションで、スコア・ステー
  // ジ・duration_ticks を導出する").
  const verified = verifyReplay(seed, rle);
  if (!verified.ok) {
    return jsonResponse({ error: verified.reason, accepted: false }, 422);
  }

  const replayHash = await computeReplayHash({
    seasonId: CURRENT_SEASON_ID,
    rulesetVersion: RULESET_VERSION,
    seed,
    rle,
  });

  const id = generateShareId();
  const createdAt = Date.now();

  // 3. D1 batch (docs/plans/2026-08-16-score-ranking task 3: "候補 INSERT →
  // 11位以下を削除 → 候補が残ったか確認" — a single batch() call, one
  // implicit transaction). If the candidate's replay_hash already exists
  // (UNIQUE constraint), the whole batch throws/rolls back and nothing else
  // runs — see the catch block below.
  let batchResults;
  try {
    batchResults = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO scores
           (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        CURRENT_SEASON_ID,
        RULESET_VERSION,
        REPLAY_FORMAT_VERSION,
        verified.score,
        verified.stage,
        nameResult.value,
        xHandleResult.value,
        seed,
        rle,
        verified.durationTicks,
        replayHash,
        createdAt
      ),
      env.DB.prepare(
        `DELETE FROM scores
         WHERE season_id = ?1 AND ruleset_version = ?2
           AND rank_seq NOT IN (
             SELECT rank_seq FROM scores
             WHERE season_id = ?1 AND ruleset_version = ?2
             ORDER BY score DESC, rank_seq ASC
             LIMIT 10
           )`
      ).bind(CURRENT_SEASON_ID, RULESET_VERSION),
      env.DB.prepare(
        `SELECT id FROM scores
         WHERE season_id = ?1 AND ruleset_version = ?2
         ORDER BY score DESC, rank_seq ASC
         LIMIT 10`
      ).bind(CURRENT_SEASON_ID, RULESET_VERSION),
    ]);
  } catch (err) {
    // D1's UNIQUE constraint violation (replay_hash) is the only expected
    // failure mode here — every other input was already validated above.
    return jsonResponse({ error: 'duplicate replay', accepted: false, detail: String(err) }, 409);
  }

  const top10Ids = (batchResults[2].results as { id: string }[]).map((r) => r.id);
  const rank = top10Ids.indexOf(id);
  const accepted = rank !== -1;

  return jsonResponse(
    {
      accepted,
      id: accepted ? id : null,
      rank: accepted ? rank + 1 : null,
      score: verified.score,
      stage: verified.stage,
      durationTicks: verified.durationTicks,
    },
    200
  );
};
