// Stage progression / difficulty curve. Pure logic — no DOM/Canvas
// dependencies. See docs/plan.md §3.7 for the table this implements.
import {
  TICK_RATE,
  DEFAULT_REQUIRED_OCCUPANCY,
  EMBER_SPAWN_INTERVAL_SEC,
  STAGE2_WISP_SPEED_MULTIPLIER,
  STAGE2_EMBER_SPAWN_INTERVAL_SEC,
  STAGE3_WISP_COUNT,
  STAGE3_WISP_SPEED_MULTIPLIER_BASE,
  WISP_SPEED_MULTIPLIER_STEP,
  WISP_SPEED_MULTIPLIER_MAX,
  STAGE3_EMBER_SPAWN_INTERVAL_SEC,
  EMBER_SPAWN_INTERVAL_STEP_SEC,
  EMBER_SPAWN_INTERVAL_MIN_SEC,
  REQUIRED_OCCUPANCY_STEP,
  REQUIRED_OCCUPANCY_MAX,
} from '../config';

export interface StageConfig {
  /** The (normalized: >= 1, integral) stage number this config is for. */
  stage: number;
  /** Number of Wisps present this stage (docs/plan.md §3.7: 1, or 2 from stage 3+). */
  wispCount: number;
  /** Multiplies WISP_SPEED (docs/plan.md §3.7: x1 stage 1, x1.15 stage 2, escalating up to x2 cap from stage 3+). */
  wispSpeedMultiplier: number;
  /** Ember spawn interval in ticks (docs/plan.md §3.7: 30s stage 1, 25s stage 2, down to a 10s floor from stage 3+). */
  emberSpawnIntervalTicks: number;
  /** Fraction [0,1] of the field that must be claimed to clear this stage (docs/plan.md §3.3/§3.7). */
  requiredOccupancy: number;
}

/**
 * Difficulty parameters for a given stage number (docs/plan.md §3.7):
 *
 * - stage 1: 1 Wisp, baseline speed, 30s Ember interval, 65% required.
 * - stage 2: 1 Wisp, x1.15 speed, 25s Ember interval, 65% required.
 * - stage 3+: 2 Wisps (split-clearable, §4.2). Speed and Ember interval
 *   escalate one step per stage beyond 3 (capped at x2 speed / floored at
 *   10s), and required occupancy escalates toward a 75% cap.
 *
 * `stage` values below 1 (or fractional) are normalized to 1 — there is no
 * "stage 0".
 */
export function getStageConfig(stage: number): StageConfig {
  const s = Math.max(1, Math.floor(stage));

  if (s === 1) {
    return {
      stage: s,
      wispCount: 1,
      wispSpeedMultiplier: 1,
      emberSpawnIntervalTicks: secondsToTicks(EMBER_SPAWN_INTERVAL_SEC),
      requiredOccupancy: DEFAULT_REQUIRED_OCCUPANCY,
    };
  }

  if (s === 2) {
    return {
      stage: s,
      wispCount: 1,
      wispSpeedMultiplier: STAGE2_WISP_SPEED_MULTIPLIER,
      emberSpawnIntervalTicks: secondsToTicks(STAGE2_EMBER_SPAWN_INTERVAL_SEC),
      requiredOccupancy: DEFAULT_REQUIRED_OCCUPANCY,
    };
  }

  // Stage 3+: 0 at stage 3, 1 at stage 4, 2 at stage 5, ...
  const extra = s - 3;

  const wispSpeedMultiplier = Math.min(
    WISP_SPEED_MULTIPLIER_MAX,
    STAGE3_WISP_SPEED_MULTIPLIER_BASE + extra * WISP_SPEED_MULTIPLIER_STEP
  );
  const emberSpawnIntervalSec = Math.max(
    EMBER_SPAWN_INTERVAL_MIN_SEC,
    STAGE3_EMBER_SPAWN_INTERVAL_SEC - extra * EMBER_SPAWN_INTERVAL_STEP_SEC
  );
  // +1 step already at stage 3 itself (extra=0) so occupancy strictly
  // increases from the stage 1-2 baseline as soon as 2-Wisp stages begin.
  const requiredOccupancy = Math.min(
    REQUIRED_OCCUPANCY_MAX,
    DEFAULT_REQUIRED_OCCUPANCY + (extra + 1) * REQUIRED_OCCUPANCY_STEP
  );

  return {
    stage: s,
    wispCount: STAGE3_WISP_COUNT,
    wispSpeedMultiplier,
    emberSpawnIntervalTicks: secondsToTicks(emberSpawnIntervalSec),
    requiredOccupancy,
  };
}

function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_RATE);
}
