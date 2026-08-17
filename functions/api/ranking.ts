// GET /api/ranking (docs/plans/2026-08-16-score-ranking task 3): the current
// season + ruleset's top 10, ordered score DESC, rank_seq ASC (task 3's
// confirmed 順位規則 — rank_seq, not created_at, breaks same-score ties,
// since two rows can share a millisecond-resolution created_at but never a
// rank_seq).
import type { Env } from '../_lib/types';
import { jsonResponse } from '../_lib/response';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../_lib/ranking/season';
import type { RankingEntry } from '../_lib/ranking/types';

interface RankingRow {
  id: string;
  score: number;
  stage: number;
  name: string;
  x_handle: string | null;
  replay_format_version: number;
  created_at: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;

  const { results } = await env.DB.prepare(
    `SELECT id, score, stage, name, x_handle, replay_format_version, created_at
     FROM scores
     WHERE season_id = ?1 AND ruleset_version = ?2
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

  return jsonResponse({ seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, entries }, 200);
};
