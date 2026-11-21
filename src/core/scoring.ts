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
 * pts/cell for a slow line (double), both scaled by `multiplier` and by
 * `bigClaimMultiplier` (1 unless the claim is a big claim, see
 * isBigClaim()), then truncated to an integer once (no fractional points
 * awarded) — e.g. 3001 fast cells at x1 as a big claim (x1.5):
 * floor(3001 * 0.5 * 1 * 1.5) = 2250.
 */
export function scoreAreaClaim(
  claimedCells: number,
  speed: LineSpeed,
  multiplier: number,
  bigClaimMultiplier = 1
): number {
  const perCell = speed === 'slow' ? SCORE_PER_CELL_SLOW : SCORE_PER_CELL_FAST;
  return Math.floor(claimedCells * perCell * multiplier * bigClaimMultiplier);
}

/**
 * True when one claim of `claimedCells` cells fills at least `share` of the
 * field's `claimableCells` (Field.getClaimableCellCount(), the occupancy's
 * denominator). Exactly `share` counts. Compared as a ratio of the two
 * integers: that division rounds to the double nearest the true ratio, so a
 * claim of exactly the share (15 of 100 at 0.15) is never lost to rounding,
 * as `share * claimableCells` (15.000000000000002) would lose it.
 */
export function isBigClaim(claimedCells: number, claimableCells: number, share: number): boolean {
  if (claimableCells <= 0 || claimedCells <= 0) return false;
  return claimedCells / claimableCells >= share;
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
