// Stage progression / difficulty curve. Pure logic — no DOM/Canvas
// dependencies. See docs/plan.md §12.7 for the interpolation table this
// implements (replacing the earlier §3.7 step-based table).
import {
  TICK_RATE,
  STAGE_MAX_DIFFICULTY,
  DEFAULT_REQUIRED_OCCUPANCY,
  REQUIRED_OCCUPANCY_MAX,
  WISP_SPEED_MULTIPLIER_MAX,
  EMBER_MOVE_TICKS,
  EMBER_MOVE_TICKS_MIN,
  EMBER_BRANCH_CHASE_PROBABILITY,
  EMBER_BRANCH_CHASE_PROBABILITY_MAX,
  EMBER_SPAWN_INTERVAL_SEC,
  EMBER_SPAWN_INTERVAL_MIN_SEC,
  EMBER_MAX_CONCURRENT_STAGE1,
  EMBER_MAX_CONCURRENT_MAX,
} from '../config';

export interface StageConfig {
  /** The (normalized: >= 1, integral) stage number this config is for. */
  stage: number;
  /** Number of Wisps present this stage (docs/plan.md §12.7: stage n = n Wisps, capped at STAGE_MAX_DIFFICULTY). */
  wispCount: number;
  /** Multiplies WISP_SPEED (docs/plan.md §12.7: x1.0 stage 1 -> x5.0 stage 10). */
  wispSpeedMultiplier: number;
  /** Ember spawn interval in ticks (docs/plan.md §12.7: 30s stage 1 -> 5s stage 10). */
  emberSpawnIntervalTicks: number;
  /** Ticks per BORDER-cell step for every Ember (docs/plan.md §12.7: 3 stage 1 -> 1 stage 10 — smaller is faster). */
  emberMoveTicks: number;
  /** Branch-chase probability [0,1] for every Ember (docs/plan.md §12.7: 0.7 stage 1 -> 1.0 stage 10). */
  emberBranchChaseProbability: number;
  /** Max Embers allowed alive at once before spawning is skipped (docs/plan.md §12.7: 2 stage 1 -> 10 stage 10). */
  maxConcurrentEmbers: number;
  /** Fraction [0,1] of the field that must be claimed to clear this stage (docs/plan.md §12.7: 65% stage 1 -> 90% stage 10). */
  requiredOccupancy: number;
}

/**
 * Difficulty parameters for a given stage number (docs/plan.md §12.7): every
 * parameter is linearly interpolated between its stage-1 baseline and its
 * stage-STAGE_MAX_DIFFICULTY (10) max, reaching the max exactly at stage 10
 * and holding it for every stage beyond ("11 面以降は最大のまま"). Wisp count
 * is the one exception to "interpolated" — it's simply the stage number
 * itself (1 Wisp at stage 1, 2 at stage 2, ... 10 at stage 10+), which is
 * already linear by construction.
 *
 * `stage` values below 1 (or fractional) are normalized to 1 — there is no
 * "stage 0".
 */
export function getStageConfig(stage: number): StageConfig {
  const s = Math.max(1, Math.floor(stage));
  // Progress through the stage 1 -> STAGE_MAX_DIFFICULTY curve, clamped to
  // 1.0 (i.e. "stage 10 or later") once s reaches or passes the max.
  const progress = (Math.min(s, STAGE_MAX_DIFFICULTY) - 1) / (STAGE_MAX_DIFFICULTY - 1);

  const wispCount = Math.min(s, STAGE_MAX_DIFFICULTY);
  const wispSpeedMultiplier = lerp(1, WISP_SPEED_MULTIPLIER_MAX, progress);
  const emberMoveTicks = Math.round(lerp(EMBER_MOVE_TICKS, EMBER_MOVE_TICKS_MIN, progress));
  const emberBranchChaseProbability = lerp(
    EMBER_BRANCH_CHASE_PROBABILITY,
    EMBER_BRANCH_CHASE_PROBABILITY_MAX,
    progress
  );
  const emberSpawnIntervalSec = Math.round(lerp(EMBER_SPAWN_INTERVAL_SEC, EMBER_SPAWN_INTERVAL_MIN_SEC, progress));
  const maxConcurrentEmbers = Math.round(lerp(EMBER_MAX_CONCURRENT_STAGE1, EMBER_MAX_CONCURRENT_MAX, progress));
  // Rounded to the nearest whole percentage point (docs/plan.md §12.7:
  // 65, 68, 71, 73, 76, 79, 82, 84, 87, 90), not left as a raw fraction —
  // otherwise stage 2's 0.677... would floor to a required "67%" instead of
  // the documented 68%.
  const requiredOccupancy =
    Math.round(lerp(DEFAULT_REQUIRED_OCCUPANCY, REQUIRED_OCCUPANCY_MAX, progress) * 100) / 100;

  return {
    stage: s,
    wispCount,
    wispSpeedMultiplier,
    emberSpawnIntervalTicks: secondsToTicks(emberSpawnIntervalSec),
    emberMoveTicks,
    emberBranchChaseProbability,
    maxConcurrentEmbers,
    requiredOccupancy,
  };
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_RATE);
}
