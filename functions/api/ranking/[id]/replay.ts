// GET /api/ranking/:id/replay (docs/plans/2026-08-16-score-ranking task 3,
// revised by docs/plans/2026-08-19-ranking-free-async spec item 7 on
// 2026-08-20): returns the (seed, RLE input list, version info) needed to
// replay a ranked run, plus the row's `status`. Since 2026-08-22 the viewer
// does NOT render that field (a pending replay plays exactly like a verified
// one); it is served for operations and debugging — telling, from a curl,
// whether a row has been audited yet.
//
// The judgement order below is FIXED, and the first matching rule wins:
//
//   1. no such row (never existed, or the audit deleted it)      -> 404
//   2. pending AND expired (the shared 24h boundary)             -> 404
//   3. season/ruleset/format differs from this server's current  -> 410
//   4. anything else (fresh pending, or a version-matched verified row)
//                                                               -> 200 + status
//
// Fixing the order is the point of the revision: an expired pending row at an
// old ruleset used to be describable as both "gone" and "wrong version", and
// two handlers could disagree about which. Rule 2 settles it before rule 3 is
// ever evaluated. Verified rows skip rule 2 entirely — age never matters to
// a confirmed row.
//
// Note what is NOT here anymore: the old `AND status = 'verified'` filter.
// Pending rows are part of the merged board now (spec item 5), so refusing to
// serve their replays would leave a visible row with a dead REPLAY button.
// The lookup is by id alone, and status is a response field.
import type { Env } from '../../../_lib/types';
import { jsonResponse } from '../../../_lib/response';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../../_lib/ranking/season';
import { pendingFreshnessCutoff, isPendingExpired } from '../../../_lib/ranking/pendingGate';
import type { ReplayPayload } from '../../../_lib/ranking/types';

interface ReplayRow {
  season_id: number;
  ruleset_version: number;
  replay_format_version: number;
  seed: number;
  inputs: ArrayBuffer;
  status: 'verified' | 'pending';
  created_at: number;
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
    `SELECT season_id, ruleset_version, replay_format_version, seed, inputs, status, created_at
     FROM scores WHERE id = ?`
  )
    .bind(id)
    .first<ReplayRow>();

  // Judgement 1: no row at all — never existed, or the audit found it invalid
  // and deleted it. Indistinguishable on purpose: neither case should tell a
  // caller anything about ids it does not already hold.
  if (!row) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  // Judgement 2: an expired pending row is treated as if it were gone — the
  // audit's own sweep will delete it shortly, and until then it must not be
  // servable. Same 24h boundary as everywhere else (`created_at <= cutoff`).
  if (row.status === 'pending' && isPendingExpired(row.created_at, pendingFreshnessCutoff(Date.now()))) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  // Judgement 3: version drift, for pending and verified rows alike. 410
  // Gone, and the row itself is untouched (task 3's confirmed spec —
  // "データ自体は保持し、削除しないこと"); only this endpoint refuses it.
  const isCurrent =
    row.season_id === CURRENT_SEASON_ID && row.ruleset_version === RULESET_VERSION && row.replay_format_version === REPLAY_FORMAT_VERSION;
  if (!isCurrent) {
    return jsonResponse({ error: 'replay not available for this season/ruleset/format', replayAvailable: false }, 410);
  }

  // Judgement 4: servable. `status` travels with the payload for operations
  // and debugging (spec item 7 as amended 2026-08-22 — the viewer plays a
  // pending run exactly like a verified one and does not render it).
  const payload: ReplayPayload = {
    seed: row.seed,
    rleBase64: bytesToBase64(new Uint8Array(row.inputs)),
    rulesetVersion: row.ruleset_version,
    replayFormatVersion: row.replay_format_version,
    status: row.status,
  };
  return jsonResponse(payload, 200);
};
