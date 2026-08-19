// GET /api/ranking/:id/replay (docs/plans/2026-08-16-score-ranking task 3,
// extended by docs/plans/2026-08-19-ranking-free-async spec item 6): returns
// the (seed, RLE input list, version info) needed to replay a ranked run.
// Only ever served when the row's season_id, ruleset_version, AND
// replay_format_version all match the server's current values — an old ID
// whose season/ruleset/format has since moved on gets 410 (data is kept,
// never deleted; see task 3's confirmed spec).
//
// Free-async addition: the lookup itself now requires `status = 'verified'`
// — a pending row's replay is not served at all. This is enforced in SQL
// (`WHERE id = ? AND status = 'verified'`), not just in the UI: a pending
// row simply doesn't match the WHERE clause, so `first()` returns null and
// this handler's existing "row not found" path (404) fires naturally —
// deliberately distinct from the 410 below (which means "row exists, but
// this endpoint refuses to serve it for this season/ruleset/format"). A
// pending ID is never served even by a direct, UI-bypassing request.
import type { Env } from '../../../_lib/types';
import { jsonResponse } from '../../../_lib/response';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../../_lib/ranking/season';
import type { ReplayPayload } from '../../../_lib/ranking/types';

interface ReplayRow {
  season_id: number;
  ruleset_version: number;
  replay_format_version: number;
  seed: number;
  inputs: ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, params } = context;
  const id = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] : undefined;
  if (!id) {
    return jsonResponse({ error: 'missing id' }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT season_id, ruleset_version, replay_format_version, seed, inputs
     FROM scores WHERE id = ? AND status = 'verified'`
  )
    .bind(id)
    .first<ReplayRow>();

  if (!row) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  const isCurrent =
    row.season_id === CURRENT_SEASON_ID && row.ruleset_version === RULESET_VERSION && row.replay_format_version === REPLAY_FORMAT_VERSION;
  if (!isCurrent) {
    // 410 Gone: the row itself is untouched (task 3's confirmed spec —
    // "データ自体は保持し、削除しないこと"), only this endpoint refuses to
    // serve it.
    return jsonResponse({ error: 'replay not available for this season/ruleset/format', replayAvailable: false }, 410);
  }

  const payload: ReplayPayload = {
    seed: row.seed,
    rleBase64: bytesToBase64(new Uint8Array(row.inputs)),
    rulesetVersion: row.ruleset_version,
    replayFormatVersion: row.replay_format_version,
  };
  return jsonResponse(payload, 200);
};
