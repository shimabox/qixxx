import { describe, it, expect } from 'vitest';
import { validateSeed, MAX_SEED } from './seedValidation';

describe('validateSeed', () => {
  it('accepts the full uint32 range a real client can produce', () => {
    for (const seed of [0, 1, 1264, 2 ** 31, MAX_SEED]) {
      const result = validateSeed(seed);
      expect(result).toEqual({ ok: true, value: seed });
    }
  });

  it('rejects values outside [0, 2^32 - 1]', () => {
    for (const seed of [-1, -0.5, MAX_SEED + 1, 2 ** 32, 2 ** 53]) {
      const result = validateSeed(seed);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects non-integers, NaN and Infinity', () => {
    for (const seed of [1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = validateSeed(seed);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/integer/);
    }
  });

  it('rejects non-number types (including numeric strings)', () => {
    for (const seed of ['1264', '', null, undefined, {}, [], true]) {
      expect(validateSeed(seed).ok).toBe(false);
    }
  });

  it('reports the range in the reason for an in-type but out-of-range seed', () => {
    const result = validateSeed(MAX_SEED + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(String(MAX_SEED));
  });
});
