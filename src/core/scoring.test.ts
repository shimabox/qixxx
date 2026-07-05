import { describe, it, expect } from 'vitest';
import { scoreAreaClaim, scoreStageClearBonus, DEFAULT_SCORE_MULTIPLIER } from './scoring';

describe('scoreAreaClaim (docs/plan.md §3.6)', () => {
  it('scores a slow-claimed area at double a fast-claimed area of the same size', () => {
    const fast = scoreAreaClaim(100, 'fast', 1);
    const slow = scoreAreaClaim(100, 'slow', 1);

    expect(fast).toBe(50);
    expect(slow).toBe(100);
    expect(slow).toBe(fast * 2);
  });

  it('truncates fractional points (no rounding up)', () => {
    // 3 cells * 0.5 pts/cell = 1.5 -> floors to 1.
    expect(scoreAreaClaim(3, 'fast', 1)).toBe(1);
  });

  it('scales by the multiplier', () => {
    expect(scoreAreaClaim(10, 'fast', 3)).toBe(15); // 10 * 0.5 * 3 = 15
    expect(scoreAreaClaim(10, 'slow', 2)).toBe(20); // 10 * 1.0 * 2 = 20
  });

  it('defaults to a multiplier of 1', () => {
    expect(DEFAULT_SCORE_MULTIPLIER).toBe(1);
  });

  it('returns 0 for an empty claim', () => {
    expect(scoreAreaClaim(0, 'fast', 1)).toBe(0);
    expect(scoreAreaClaim(0, 'slow', 5)).toBe(0);
  });
});

describe('scoreStageClearBonus (docs/plan.md §3.6)', () => {
  it('computes the documented example: 70% achieved vs. 65% required -> 500', () => {
    expect(scoreStageClearBonus(0.7, 0.65)).toBe(500);
  });

  it('is 0 when occupancy exactly meets the requirement', () => {
    expect(scoreStageClearBonus(0.65, 0.65)).toBe(0);
  });

  it('truncates a fractional percentage-point excess', () => {
    // (0.6733 - 0.65) * 100 * 100 = 233.0000...something -> floors sanely.
    expect(scoreStageClearBonus(0.6733, 0.65)).toBe(233);
  });

  it('never returns a negative bonus, even if achieved is (unexpectedly) below required', () => {
    expect(scoreStageClearBonus(0.5, 0.65)).toBe(0);
  });
});
