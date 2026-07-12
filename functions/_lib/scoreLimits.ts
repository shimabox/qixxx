// Theoretical score ceiling used by POST /share's "理論上限チェック"
// (docs/plan-cloudflare-x-share.md Phase 2). Reuses the game's own scoring
// constants (src/config.ts) rather than re-deriving magic numbers here, so
// the two can never silently drift apart.
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  SCORE_PER_CELL_SLOW,
  SPLIT_MULTIPLIER_CAP,
  STAGE_CLEAR_BONUS_PER_PERCENT_POINT,
  DEFAULT_REQUIRED_OCCUPANCY,
} from '../../src/config';

// Upper bound on cells claimable in a single stage: the whole grid. The real
// game reserves some cells for BORDER/enemies and requires < 100% occupancy
// to clear (see DEFAULT_REQUIRED_OCCUPANCY..REQUIRED_OCCUPANCY_MAX in
// src/config.ts), so this over-counts on purpose — the goal is a
// conservative ceiling that never rejects a legitimate run, not a tight one.
const TOTAL_CELLS = GRID_WIDTH * GRID_HEIGHT;

// Upper bound on a single stage-clear's area score: every one of those cells
// claimed by the *slower* (higher-scoring) line speed, each further
// multiplied by the highest attainable split-success multiplier
// (SPLIT_MULTIPLIER_CAP, docs/plan.md §3.6). Real play can never actually
// reach this (claiming literally 100% of the grid at 1.0 pts/cell while
// holding a 9x multiplier the entire stage), which is exactly the point —
// it's a safe ceiling, not a realistic target.
const MAX_AREA_SCORE_PER_STAGE = TOTAL_CELLS * SCORE_PER_CELL_SLOW * SPLIT_MULTIPLIER_CAP;

// Upper bound on a single stage-clear's bonus (src/core/scoring.ts's
// scoreStageClearBonus): (achieved% - required%) * 100 *
// STAGE_CLEAR_BONUS_PER_PERCENT_POINT, maximized by the best case for the
// player on *both* sides — 100% achieved occupancy against the *lowest*
// required-occupancy threshold that exists across the whole stage curve
// (DEFAULT_REQUIRED_OCCUPANCY = stage 1's 65%; every later stage only
// raises the requirement, shrinking the possible bonus — see
// src/core/stage.ts's getStageConfig()). Using the loosest (stage 1)
// threshold for every stage keeps this a safe upper bound rather than a
// stage-accurate one.
const MAX_STAGE_CLEAR_BONUS = Math.floor(
  (1 - DEFAULT_REQUIRED_OCCUPANCY) * 100 * STAGE_CLEAR_BONUS_PER_PERCENT_POINT
);

// Per-stage ceiling: full-grid area score at the max multiplier, plus the
// max clear bonus, once per stage played.
const MAX_SCORE_PER_STAGE = MAX_AREA_SCORE_PER_STAGE + MAX_STAGE_CLEAR_BONUS;

/**
 * Conservative upper bound on the score obtainable by the time a player
 * reaches GAME OVER having been on stage `stage` (docs/plan-cloudflare-x-share.md
 * Phase 2: "ステージ n で GAME OVER = ステージ 1..n をプレイし得た"). Assumes
 * every one of stages 1..n was cleared at the theoretical per-stage max
 * (MAX_SCORE_PER_STAGE) — deliberately generous (real play can never
 * approach it) so this only rejects scores that are outright impossible,
 * never a legitimate high-skill run.
 *
 * `stage` values below 1 (or fractional) are normalized to 1, mirroring
 * src/core/stage.ts's getStageConfig().
 */
export function maxScoreForStage(stage: number): number {
  const n = Math.max(1, Math.floor(stage));
  return n * MAX_SCORE_PER_STAGE;
}
