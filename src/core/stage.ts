// Stage progression / difficulty. Pure logic — no DOM/Canvas dependencies.
// Every stage's values come from config.ts's STAGE_TABLE: each stage has its
// own character (more Wisps, faster Wisps, more Embers, a breather) rather
// than every value rising together with the stage number.
import {
  TICK_RATE,
  STAGE_TABLE,
  StageTitleId,
  EMBER_BRANCH_CHASE_PROBABILITY,
  EMBER_BRANCH_CHASE_PROBABILITY_MAX,
  EMBER_BRANCH_CHASE_MAX_STAGE,
} from '../config';

export interface StageConfig {
  /** The (normalized: >= 1, integral) stage number this config is for. */
  stage: number;
  /** Which title the stage shows when it starts (src/i18n's `stageTitle.<id>`). */
  titleId: StageTitleId;
  /** Number of Wisps present this stage. */
  wispCount: number;
  /** Multiplies WISP_SPEED for every Wisp this stage. */
  wispSpeedMultiplier: number;
  /** Ember spawn interval in ticks (between one pair and the next). */
  emberSpawnIntervalTicks: number;
  /** Ticks from the stage's start to its first Ember pair. */
  firstEmberSpawnTicks: number;
  /** Ticks per BORDER-cell step for every Ember (smaller is faster). */
  emberMoveTicks: number;
  /** Branch-chase probability [0,1] for every Ember (0.7 at stage 1 -> 1.0 by stage 4). */
  emberBranchChaseProbability: number;
  /** Max Embers allowed alive at once before spawning is skipped. */
  maxConcurrentEmbers: number;
  /** Fraction [0,1] of the field that must be claimed to clear this stage. */
  requiredOccupancy: number;
}

/** The STAGE_TABLE row a stage plays: `stage` normalized to >= 1 and integral, past the last row the last row. */
export function normalizeStage(stage: number): number {
  return Math.max(1, Math.floor(stage));
}

/**
 * Difficulty parameters for a given stage number: the stage's STAGE_TABLE
 * row (every stage past the table plays its last row). The branch-chase
 * probability alone is interpolated, linearly from stage 1 to
 * EMBER_BRANCH_CHASE_MAX_STAGE and held there after it.
 *
 * `stage` values below 1 (or fractional) are normalized to 1 — there is no
 * "stage 0".
 */
export function getStageConfig(stage: number): StageConfig {
  const s = normalizeStage(stage);
  const row = STAGE_TABLE[Math.min(s, STAGE_TABLE.length) - 1];
  const chaseProgress = (Math.min(s, EMBER_BRANCH_CHASE_MAX_STAGE) - 1) / (EMBER_BRANCH_CHASE_MAX_STAGE - 1);

  return {
    stage: s,
    titleId: row.titleId,
    wispCount: row.wispCount,
    wispSpeedMultiplier: row.wispSpeedMultiplier,
    emberSpawnIntervalTicks: secondsToTicks(row.emberSpawnIntervalSec),
    firstEmberSpawnTicks: secondsToTicks(row.firstEmberSec),
    emberMoveTicks: row.emberMoveTicks,
    emberBranchChaseProbability: lerp(EMBER_BRANCH_CHASE_PROBABILITY, EMBER_BRANCH_CHASE_PROBABILITY_MAX, chaseProgress),
    maxConcurrentEmbers: row.maxConcurrentEmbers,
    requiredOccupancy: row.requiredOccupancy,
  };
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_RATE);
}
