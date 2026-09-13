import { describe, it, expect } from 'vitest';
import { computeRngKey } from './rngKey';
import { deriveStageSeed } from '../../../src/core/rng';

describe('computeRngKey', () => {
  it('is the stage-1 sub-seed', () => {
    for (const seed of [0, 1, 1264, 4294967295]) {
      expect(computeRngKey(seed)).toBe(deriveStageSeed(seed, 1));
    }
  });

  it('is an unsigned 32-bit integer', () => {
    const key = computeRngKey(4294967295);
    expect(Number.isInteger(key)).toBe(true);
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).toBeLessThanOrEqual(4294967295);
  });

  it('is equal for seeds that produce the same rng streams on every stage', () => {
    const a = 1485211075;
    const b = 2522981067;
    expect(a).not.toBe(b);
    for (let stage = 1; stage <= 12; stage++) {
      expect(deriveStageSeed(a, stage)).toBe(deriveStageSeed(b, stage));
    }
    expect(computeRngKey(a)).toBe(computeRngKey(b));
  });

  it('differs for seeds whose streams differ', () => {
    expect(computeRngKey(1485211075)).not.toBe(computeRngKey(1485211076));
    expect(computeRngKey(0)).not.toBe(computeRngKey(1));
  });
});
