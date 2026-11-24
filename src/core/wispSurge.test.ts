import { describe, it, expect } from 'vitest';
import { wispSurgeLevel, wispSurgeMultiplier } from './wispSurge';

describe('wispSurgeLevel', () => {
  it('on a goal of 0.70: level 0 up to half of it, 1 past half, 2 within 0.10 of it', () => {
    expect(wispSurgeLevel(0, 0.7)).toBe(0);
    expect(wispSurgeLevel(0.35, 0.7)).toBe(0);
    expect(wispSurgeLevel(0.3501, 0.7)).toBe(1);
    expect(wispSurgeLevel(0.5999, 0.7)).toBe(1);
    expect(wispSurgeLevel(0.6, 0.7)).toBe(2);
    expect(wispSurgeLevel(0.7, 0.7)).toBe(2);
  });

  it('on a goal of 0.80: 0.70 is level 2, though 0.8 - 0.1 is 0.7000000000000001 in floating point', () => {
    expect(0.8 - 0.1).not.toBe(0.7);
    expect(wispSurgeLevel(0.4, 0.8)).toBe(0);
    expect(wispSurgeLevel(0.6999, 0.8)).toBe(1);
    expect(wispSurgeLevel(0.7, 0.8)).toBe(2);
  });

  it('on a goal of 0.10: 0 and 0.05 are level 0, 0.06 is already level 2', () => {
    expect(wispSurgeLevel(0, 0.1)).toBe(0);
    expect(wispSurgeLevel(0.05, 0.1)).toBe(0);
    expect(wispSurgeLevel(0.06, 0.1)).toBe(2);
  });

  it('on a goal of 0.00001: an occupancy of 0 is level 0', () => {
    expect(wispSurgeLevel(0, 0.00001)).toBe(0);
  });
});

describe('wispSurgeMultiplier', () => {
  it('is x1, x1.15 and x1.3 for levels 0, 1 and 2', () => {
    expect(wispSurgeMultiplier(0)).toBe(1);
    expect(wispSurgeMultiplier(1)).toBe(1.15);
    expect(wispSurgeMultiplier(2)).toBe(1.3);
  });
});
