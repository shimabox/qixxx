// GET /api/ranking for the asynchronous-audit ranking. Returns two
// independently-computed field families:
//
// - `entries`: the CONFIRMED board — verified rows only, top 10, ordered
// score DESC, rank_seq ASC (rank_seq, not created_at, breaks same-score
// ties — two rows can share a millisecond-resolution created_at but never
// a rank_seq). This is the submission-eligibility basis and nothing else:
// the client's own "am I in range?" check (src/ui/ranking.ts's
// decideSubmissionOffer) and POST's pre-pending gate (functions/_lib/
// ranking/pendingGate.ts) both read THIS, never displayEntries.
// - `displayEntries`: the board the UI DRAWS — verified merged with the
// freshest few pending rows under the same official ordering, each row
// tagged `status`. Purely presentational: the merged view influences
// neither the pre-gate nor the atomic
// INSERT's caps, so a flood of pending rows can never make a legitimate
// submission un-acceptable.
//
// The two are computed from separate queries on purpose — `entries` is not
// derived from `displayEntries` (nor vice versa), so no future edit to the
// display side can quietly move the eligibility boundary.
import type { Env } from '../_lib/types';
import { jsonResponse } from '../_lib/response';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../_lib/ranking/season';
import { pendingFreshnessCutoff } from '../_lib/ranking/pendingGate';
import type { RankingEntry, DisplayRankingEntry } from '../_lib/ranking/types';

interface RankingRow {
  rank_seq: number;
  id: string;
  score: number;
  stage: number;
  name: string;
  x_handle: string | null;
  replay_format_version: number;
  created_at: number;
}

/**
 * How many pending rows may be candidates for the merged board.
 *
 * Not a cosmetic cap: with no limit, pending rows from several IPs could
 * occupy all 10 displayed slots at once, which overshoots "show it
 * provisionally" and turns the board into a griefing surface. At 3, at least
 * 7 of the 10 displayed rows are verified whenever 7 or more verified rows
 * exist.
 *
 * Distinct from MAX_PENDING_PER_IP in functions/api/scores.ts (a per-IP
 * STORAGE cap) — this one is about display only.
 */
const MAX_DISPLAY_PENDING_CANDIDATES = 3;

/** How many rows the merged board shows (and how many verified rows can matter to it). */
const DISPLAY_BOARD_SIZE = 10;

/**
 * replayAvailable for a row whose season/ruleset already matched the query's
 * WHERE clause: only replay_format_version is left to check, and it is
 * checked against THIS build's constant so the flag agrees with what
 * GET /api/ranking/:id/replay would actually do (its judgement 3).
 *
 * Correct for pending rows too: the display-candidate query below already
 * excludes expired pending rows (replay judgement 2), so a listed pending row
 * with a matching format really is servable.
 */
function toEntry(row: RankingRow): RankingEntry {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    score: row.score,
    stage: row.stage,
    name: row.name,
    xHandle: row.x_handle,
    replayAvailable: row.replay_format_version === REPLAY_FORMAT_VERSION,
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;

  const { results: verifiedRows } = await env.DB.prepare(
    `SELECT rank_seq, id, score, stage, name, x_handle, replay_format_version, created_at
     FROM scores
     WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2
     ORDER BY score DESC, rank_seq ASC
     LIMIT ?3`
  )
    .bind(CURRENT_SEASON_ID, RULESET_VERSION, DISPLAY_BOARD_SIZE)
    .all<RankingRow>();

  const entries: RankingEntry[] = verifiedRows.map(toEntry);

  // Display-pending candidates: current season/ruleset, FRESH
  // (the shared 24h boundary — `created_at > cutoff`, see
  // pendingFreshnessCutoff()), narrowed by the SAME ordering the merge below
  // uses, so a 4th same-score candidate loses to the three earliest rank_seq
  // values deterministically rather than by whatever order D1 happened to
  // return.
  //
  // Deliberately NOT filtered by the verified-10th-place threshold: that
  // threshold is the submission gate's business, and a stored pending row is
  // shown for what it is — the merge
  // itself decides whether it reaches the visible 10.
  const { results: pendingRows } = await env.DB.prepare(
    `SELECT rank_seq, id, score, stage, name, x_handle, replay_format_version, created_at
     FROM scores
     WHERE status = 'pending' AND season_id = ?1 AND ruleset_version = ?2
       AND created_at > ?3
     ORDER BY score DESC, rank_seq ASC
     LIMIT ?4`
  )
    .bind(CURRENT_SEASON_ID, RULESET_VERSION, pendingFreshnessCutoff(Date.now()), MAX_DISPLAY_PENDING_CANDIDATES)
    .all<RankingRow>();

  // Merging the verified top 10 with at most 3 pending candidates is enough
  // to produce the true merged top 10: an 11th-place verified row sits below
  // ten verified rows already in hand, so it can never reach the visible 10
  // no matter how the pending rows interleave.
  const displayEntries: DisplayRankingEntry[] = [
    ...verifiedRows.map((row) => ({ row, status: 'verified' as const })),
    ...pendingRows.map((row) => ({ row, status: 'pending' as const })),
  ]
    .sort((a, b) => b.row.score - a.row.score || a.row.rank_seq - b.row.rank_seq)
    .slice(0, DISPLAY_BOARD_SIZE)
    .map(({ row, status }) => ({ ...toEntry(row), status }));

  return jsonResponse({ seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, entries, displayEntries }, 200);
};
