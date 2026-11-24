// Wisp surge: the closer a stage's occupancy gets to its goal, the faster
// its Wisps (NORMAL from WISP_SURGE_FIRST_STAGE on — GameSession sets Game's
// `wispSurge` option). Pure logic, no
// DOM dependencies; Game decides the level on every claim and on every debug
// override change, the render layer colors the Wisp heads by it.
import {
  WISP_SURGE_FIRST_RATIO,
  WISP_SURGE_FINAL_MARGIN,
  WISP_SURGE_MULTIPLIERS,
  WISP_SURGE_EPSILON,
} from '../config';

/** 0 at a stage's start; 1 past half of the goal; 2 within the final margin of it. */
export type WispSurgeLevel = 0 | 1 | 2;

/**
 * The surge level for `occupancy` on a stage whose goal is
 * `requiredOccupancy`: 1 once occupancy is above WISP_SURGE_FIRST_RATIO of the
 * goal (exactly that share is still 0), 2 once it is also within
 * WISP_SURGE_FINAL_MARGIN of the goal (exactly that margin included). Both
 * edges allow WISP_SURGE_EPSILON of floating point error, so a goal of 0.80
 * and an occupancy of 0.70 is level 2. An occupancy of 0 is always level 0.
 */
export function wispSurgeLevel(occupancy: number, requiredOccupancy: number): WispSurgeLevel {
  if (!(occupancy > requiredOccupancy * WISP_SURGE_FIRST_RATIO + WISP_SURGE_EPSILON)) return 0;
  return requiredOccupancy - occupancy <= WISP_SURGE_FINAL_MARGIN + WISP_SURGE_EPSILON ? 2 : 1;
}

/** What `level` multiplies the Wisps' own speed multiplier by (WISP_SURGE_MULTIPLIERS). */
export function wispSurgeMultiplier(level: WispSurgeLevel): number {
  return WISP_SURGE_MULTIPLIERS[level];
}
