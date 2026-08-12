import { describe, it, expect } from 'vitest';
import { parseSeedParam } from './seedParam';

describe('parseSeedParam', () => {
  it('returns undefined when the parameter is absent', () => {
    expect(parseSeedParam(null)).toBeUndefined();
  });

  it('returns undefined for a non-numeric value', () => {
    expect(parseSeedParam('abc')).toBeUndefined();
    expect(parseSeedParam('NaN')).toBeUndefined();
    expect(parseSeedParam('Infinity')).toBeUndefined();
    expect(parseSeedParam('-Infinity')).toBeUndefined();
  });

  it('floors a fractional value, matching the pre-existing behavior', () => {
    expect(parseSeedParam('1.9')).toBe(1);
    expect(parseSeedParam('-1.5')).toBe(4294967294); // floor(-1.5) = -2, then >>> 0
  });

  it('passes small non-negative integers through unchanged (existing ?seed=1 e2e coverage depends on this)', () => {
    expect(parseSeedParam('0')).toBe(0);
    expect(parseSeedParam('1')).toBe(1);
    expect(parseSeedParam('999')).toBe(999);
  });

  it('wraps a negative integer into its unsigned 32-bit representation', () => {
    expect(parseSeedParam('-1')).toBe(4294967295);
  });

  it('clamps a value already at the unsigned 32-bit boundary to itself', () => {
    expect(parseSeedParam('4294967295')).toBe(4294967295);
  });

  it('wraps a value one past the unsigned 32-bit boundary to 0', () => {
    expect(parseSeedParam('4294967296')).toBe(0);
  });

  it('bounds an arbitrarily large finite seed to at most 10 digits (P3 fix: display no longer clips)', () => {
    const result = parseSeedParam('9007199254740991'); // Number.MAX_SAFE_INTEGER
    expect(result).toBe(4294967295);
    expect(String(result).length).toBeLessThanOrEqual(10);
  });
});
