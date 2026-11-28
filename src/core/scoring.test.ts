import { describe, it, expect } from 'vitest';
import { scoreAreaClaim, scoreStageClearBonus, isBigClaim, DEFAULT_SCORE_MULTIPLIER } from './scoring';
import { BIG_CLAIM_MULTIPLIER, BIG_CLAIM_SHARE } from '../config';

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

describe('big claims', () => {
  it('multiplies by x1.5 before the one truncation: 3001 fast cells at x1 -> 2250', () => {
    expect(BIG_CLAIM_MULTIPLIER).toBe(1.5);
    // 3001 * 0.5 * 1 * 1.5 = 2250.75; truncating 1500.5 first would give 2250.0 -> 2250 as well,
    // so 3001 slow cells check the order too: 3001 * 1.0 * 1.5 = 4501.5 -> 4501.
    expect(scoreAreaClaim(3001, 'fast', 1, BIG_CLAIM_MULTIPLIER)).toBe(2250);
    expect(scoreAreaClaim(3001, 'slow', 1, BIG_CLAIM_MULTIPLIER)).toBe(4501);
    // Truncating before x1.5 would give floor(1.5) * 1.5 = 1.5 -> 1, not floor(2.25) = 2.
    expect(scoreAreaClaim(3, 'fast', 1, BIG_CLAIM_MULTIPLIER)).toBe(2);
  });

  it('scales with the split multiplier as well', () => {
    expect(scoreAreaClaim(3001, 'fast', 2, BIG_CLAIM_MULTIPLIER)).toBe(4501); // 4501.5
    expect(scoreAreaClaim(3001, 'slow', 3, BIG_CLAIM_MULTIPLIER)).toBe(13504); // 13504.5
    expect(scoreAreaClaim(1001, 'fast', 9, BIG_CLAIM_MULTIPLIER)).toBe(6756); // 6756.75
  });

  it('is always an integer', () => {
    for (let cells = 0; cells < 400; cells++) {
      for (const speed of ['fast', 'slow'] as const) {
        for (const multiplier of [1, 2, 3, 9]) {
          expect(Number.isInteger(scoreAreaClaim(cells, speed, multiplier, BIG_CLAIM_MULTIPLIER))).toBe(true);
        }
      }
    }
  });

  it('counts a claim of at least BIG_CLAIM_SHARE of the field, the threshold itself included', () => {
    expect(BIG_CLAIM_SHARE).toBe(0.15);
    expect(isBigClaim(14, 100, BIG_CLAIM_SHARE)).toBe(false);
    expect(isBigClaim(15, 100, BIG_CLAIM_SHARE)).toBe(true); // exactly 15%: 0.15 * 100 is 15.000000000000002
    expect(isBigClaim(16, 100, BIG_CLAIM_SHARE)).toBe(true);
    // The full field's interior (158 x 118 = 18644): 15% is 2796.6 cells.
    expect(isBigClaim(2796, 18644, BIG_CLAIM_SHARE)).toBe(false);
    expect(isBigClaim(2797, 18644, BIG_CLAIM_SHARE)).toBe(true);
    expect(isBigClaim(3, 20, BIG_CLAIM_SHARE)).toBe(true); // exactly 15%
    expect(isBigClaim(0, 100, BIG_CLAIM_SHARE)).toBe(false);
    expect(isBigClaim(10, 0, BIG_CLAIM_SHARE)).toBe(false);
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
