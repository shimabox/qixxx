// The HUD's goal slot: what the player is chasing right now. Pure — no DOM,
// no storage — so every case has direct unit test coverage
// (src/hudGoal.test.ts).
import { RANKING_BOARD_SIZE } from './config';

export interface HudGoalInput {
  /**
   * 'hi': a seeded run or a replay — the slot shows the high score, as the HUD
   * always did. 'chase': a normal live run — the slot shows the next target.
   */
  mode: 'hi' | 'chase';
  /** The real score (never the counting-up display value). */
  score: number;
  /** The high score shown in 'hi' mode. */
  hiScore: number;
  /** The player's best when this run started (the live high score follows the score during play). */
  bestAtStart: number;
  /**
   * The score a run must beat to enter the ranking board
   * (RankingUI.getRankInThreshold()): 0 while the board has a free row, null
   * while unknown.
   */
  rankInThreshold: number | null;
}

/**
 * The goal slot's text:
 * - 'hi' mode: `HI <hiScore>`
 * - score at or below the best at the start of the run: `TO BEST <points left>`
 * - past that best, the board's entry score known and not yet beaten: `TO #10 <points left>`
 * - past that best and past the board's entry score: `TOP 10!`
 * - past that best, the board's entry score unknown: `NEW BEST!`
 *
 * With no best yet (0), any point is past it.
 */
export function hudGoalText(input: HudGoalInput): string {
  if (input.mode === 'hi') return `HI ${input.hiScore}`;
  const { score, bestAtStart, rankInThreshold } = input;
  if (score <= bestAtStart) return `TO BEST ${bestAtStart - score}`;
  if (rankInThreshold === null) return 'NEW BEST!';
  if (score <= rankInThreshold) return `TO #${RANKING_BOARD_SIZE} ${rankInThreshold - score}`;
  return `TOP ${RANKING_BOARD_SIZE}!`;
}
