// GET /api/ranking — Free-tier async-audit version (docs/plans/2026-08-19-
// ranking-free-async spec item 5). The confirmed board (`entries`) is
// verified-only, ordered score DESC, rank_seq ASC (rank_seq, not created_at,
// breaks same-score ties — two rows can share a millisecond-resolution
// created_at but never a rank_seq). Additionally returns `pendingEntries`:
// up to 3 unranked, provisionally-in-range pending submissions, shown
// separately from (never merged into) the confirmed board.
import type { Env } from '../_lib/types';
import { jsonResponse } from '../_lib/response';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../_lib/ranking/season';
import { getVerifiedTenthPlaceThreshold, PENDING_EXPIRY_MS } from '../_lib/ranking/pendingGate';
import type { RankingEntry, PendingRankingEntry } from '../_lib/ranking/types';

interface RankingRow {
  id: string;
  score: number;
  stage: number;
  name: string;
  x_handle: string | null;
  replay_format_version: number;
  created_at: number;
}

interface PendingRow {
  id: string;
  score: number;
  stage: number;
  name: string;
  x_handle: string | null;
  created_at: number;
}

/** Max pendingEntries rows returned (spec item 5: "申告スコア降順で最大3件"). */
const MAX_PENDING_ENTRIES = 3;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;

  const { results } = await env.DB.prepare(
    `SELECT id, score, stage, name, x_handle, replay_format_version, created_at
     FROM scores
     WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2
     ORDER BY score DESC, rank_seq ASC
     LIMIT 10`
  )
    .bind(CURRENT_SEASON_ID, RULESET_VERSION)
    .all<RankingRow>();

  const entries: RankingEntry[] = results.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    score: row.score,
    stage: row.stage,
    name: row.name,
    xHandle: row.x_handle,
    // Computed server-side from the full season/ruleset/format match (task 3's
    // confirmed spec) — season_id/ruleset_version are already guaranteed by
    // the WHERE clause above, so only replay_format_version needs checking.
    replayAvailable: row.replay_format_version === REPLAY_FORMAT_VERSION,
  }));

  // pendingEntries: same provisional-range basis as POST's own pre-gate
  // (functions/_lib/ranking/pendingGate.ts) — a pending row is only listed
  // if its declared score STRICTLY exceeds the current verified 10th place
  // (COALESCE(...,-1) when fewer than 10 verified rows exist yet), AND it is
  // not older than PENDING_EXPIRY_MS (spec item 7's "監査停止時の保護" —
  // an unaudited backlog must not keep surfacing stale-looking entries).
  const threshold = await getVerifiedTenthPlaceThreshold(env, CURRENT_SEASON_ID, RULESET_VERSION);
  const expiryCutoff = Date.now() - PENDING_EXPIRY_MS;
  const { results: pendingRows } = await env.DB.prepare(
    `SELECT id, score, stage, name, x_handle, created_at
     FROM scores
     WHERE status = 'pending' AND season_id = ?1 AND ruleset_version = ?2
       AND score > ?3 AND created_at > ?4
     ORDER BY score DESC, rank_seq ASC
     LIMIT ?5`
  )
    .bind(CURRENT_SEASON_ID, RULESET_VERSION, threshold, expiryCutoff, MAX_PENDING_ENTRIES)
    .all<PendingRow>();

  const pendingEntries: PendingRankingEntry[] = pendingRows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    score: row.score,
    stage: row.stage,
    name: row.name,
    xHandle: row.x_handle,
    unverified: true,
  }));

  return jsonResponse({ seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, entries, pendingEntries }, 200);
};
