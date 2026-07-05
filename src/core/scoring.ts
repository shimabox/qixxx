// Scoring. Pure logic — no DOM/Canvas dependencies. See docs/plan.md §3.6
// for the specification this module implements.
import { LineSpeed } from './claim';
import {
  SCORE_PER_CELL_FAST,
  SCORE_PER_CELL_SLOW,
  STAGE_CLEAR_BONUS_PER_PERCENT_POINT,
  DEFAULT_SCORE_MULTIPLIER,
} from '../config';

export { DEFAULT_SCORE_MULTIPLIER };

/**
 * Score awarded for claiming `claimedCells` cells at the given line speed
 * and multiplier (docs/plan.md §3.6): 0.5 pts/cell for a fast line, 1.0
 * pts/cell for a slow line (double), both scaled by `multiplier` and
 * truncated to an integer (no fractional points awarded).
 *
 * `multiplier` is always 1 until the M4 split-bonus mechanic lands
 * (docs/plan.md §3.5), but is threaded through now so that future change is
 * additive rather than requiring a signature change.
 */
export function scoreAreaClaim(claimedCells: number, speed: LineSpeed, multiplier: number): number {
  const perCell = speed === 'slow' ? SCORE_PER_CELL_SLOW : SCORE_PER_CELL_FAST;
  return Math.floor(claimedCells * perCell * multiplier);
}

/**
 * Excess-occupancy bonus awarded on stage clear (docs/plan.md §3.6):
 * (achieved% - required%) * 100 points — e.g. 70% achieved vs. 65% required
 * -> 5 * 100 = 500. Both inputs are fractions in [0, 1]. A non-positive
 * difference (shouldn't occur — stage clear only triggers once achieved >=
 * required) yields 0 rather than a negative bonus.
 */
export function scoreStageClearBonus(achievedOccupancy: number, requiredOccupancy: number): number {
  const diff = Math.max(0, achievedOccupancy - requiredOccupancy);
  // Occupancy values are ratios of cell counts (e.g. claimedCells / total)
  // and are rarely exactly representable in binary floating point, so a
  // genuinely-integer result (e.g. 500) can land a hair below it
  // (499.999999999...). A tiny epsilon avoids truncating that down by one
  // without affecting any real (much larger) fractional excess.
  return Math.floor(diff * 100 * STAGE_CLEAR_BONUS_PER_PERCENT_POINT + 1e-9);
}
