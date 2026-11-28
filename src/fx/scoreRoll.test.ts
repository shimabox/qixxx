import { describe, it, expect } from 'vitest';
import { ScoreRoll } from './scoreRoll';
import { FX_SCORE_ROLL_TICKS } from '../config';

const T = FX_SCORE_ROLL_TICKS;

function ticks(roll: ScoreRoll, n: number): number[] {
  const seen: number[] = [];
  for (let i = 0; i < n; i++) {
    roll.tick();
    seen.push(roll.value());
  }
  return seen;
}

describe('ScoreRoll', () => {
  it('counts up 18 ticks, whole numbers between the old and the new score, then equals the score', () => {
    expect(T).toBe(18);
    const roll = new ScoreRoll();
    roll.setTarget(1000, T);
    expect(roll.value()).toBe(0);
    expect(roll.isRolling()).toBe(true);
    const seen = ticks(roll, T);
    expect(seen.slice(0, T - 1).every((v) => Number.isInteger(v) && v >= 0 && v < 1000)).toBe(true);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[T - 1]).toBe(1000);
    expect(roll.isRolling()).toBe(false);
    expect(ticks(roll, 5)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('counts from the previous score', () => {
    const roll = new ScoreRoll();
    roll.setTarget(500, T);
    ticks(roll, T);
    roll.setTarget(537, T);
    expect(roll.value()).toBe(500);
    const seen = ticks(roll, T);
    expect(seen.every((v) => v >= 500 && v <= 537 && Number.isInteger(v))).toBe(true);
    expect(seen[T - 1]).toBe(537);
  });

  it('a new addition while counting starts again from the value shown, and lands 18 ticks after the last addition', () => {
    const roll = new ScoreRoll();
    roll.setTarget(900, T);
    ticks(roll, 9);
    const shown = roll.value();
    expect(shown).toBe(450);
    roll.setTarget(2000, T);
    expect(roll.value()).toBe(shown);
    const seen = ticks(roll, T);
    expect(seen.every((v) => v >= shown && v <= 2000)).toBe(true);
    expect(seen.slice(0, T - 1).every((v) => v < 2000)).toBe(true);
    expect(seen[T - 1]).toBe(2000);
  });

  it('shows a lower score at once', () => {
    const roll = new ScoreRoll();
    roll.setTarget(800, T);
    ticks(roll, 4);
    roll.setTarget(300, T);
    expect(roll.value()).toBe(300);
    expect(roll.isRolling()).toBe(false);
  });

  it('shows 0 (a new run) at once, even mid-count', () => {
    const roll = new ScoreRoll();
    roll.setTarget(800, T);
    ticks(roll, 4);
    roll.setTarget(0, T);
    expect(roll.value()).toBe(0);
    expect(roll.isRolling()).toBe(false);
  });

  it('snap() shows any score at once', () => {
    const roll = new ScoreRoll();
    roll.setTarget(800, T);
    roll.snap(1234);
    expect(roll.value()).toBe(1234);
    expect(roll.isRolling()).toBe(false);
    roll.setTarget(1234, T);
    expect(roll.isRolling()).toBe(false);
  });

  it('does not restart for the same score', () => {
    const roll = new ScoreRoll();
    roll.setTarget(100, T);
    ticks(roll, 5);
    const shown = roll.value();
    roll.setTarget(100, T);
    expect(roll.value()).toBe(shown);
    ticks(roll, T - 5);
    expect(roll.value()).toBe(100);
  });

  it('shows the score at once with a count length of 0', () => {
    const roll = new ScoreRoll();
    roll.setTarget(100, 0);
    expect(roll.value()).toBe(100);
    expect(roll.isRolling()).toBe(false);
  });
});
