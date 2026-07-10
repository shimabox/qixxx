import { describe, it, expect } from 'vitest';
import { maxScoreForStage } from './scoreLimits';
import { GRID_WIDTH, GRID_HEIGHT, SCORE_PER_CELL_SLOW, SPLIT_MULTIPLIER_CAP } from '../../../src/config';

describe('maxScoreForStage', () => {
  it('is monotonically increasing with stage', () => {
    expect(maxScoreForStage(2)).toBeGreaterThan(maxScoreForStage(1));
    expect(maxScoreForStage(10)).toBeGreaterThan(maxScoreForStage(9));
  });

  it('scales exactly linearly with stage (n * per-stage ceiling)', () => {
    const perStage = maxScoreForStage(1);
    expect(maxScoreForStage(5)).toBe(perStage * 5);
    expect(maxScoreForStage(12)).toBe(perStage * 12);
  });

  it('normalizes stage < 1 (or fractional) to stage 1, mirroring core/stage.ts', () => {
    expect(maxScoreForStage(0)).toBe(maxScoreForStage(1));
    expect(maxScoreForStage(-5)).toBe(maxScoreForStage(1));
    expect(maxScoreForStage(1.9)).toBe(maxScoreForStage(1));
  });

  it('matches the documented derivation: full grid at slow speed * split cap, plus the max clear bonus', () => {
    const totalCells = GRID_WIDTH * GRID_HEIGHT;
    const maxAreaScore = totalCells * SCORE_PER_CELL_SLOW * SPLIT_MULTIPLIER_CAP;
    // Max clear bonus: 100% achieved vs. the loosest (65%) requirement,
    // i.e. 35 percentage points * STAGE_CLEAR_BONUS_PER_PERCENT_POINT (100) = 3500.
    const maxClearBonus = 3500;
    expect(maxScoreForStage(1)).toBe(maxAreaScore + maxClearBonus);
  });

  it('is comfortably above any realistic score for a low stage (sanity check)', () => {
    // A plausible "great run" score is in the low tens of thousands even at
    // stage 3-4; the ceiling should leave enormous headroom above that.
    expect(maxScoreForStage(3)).toBeGreaterThan(100_000);
  });
});
