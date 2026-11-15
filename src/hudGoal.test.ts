import { describe, it, expect } from 'vitest';
import { hudGoalText, HudGoalInput } from './hudGoal';

const base: HudGoalInput = { mode: 'chase', score: 0, hiScore: 0, bestAtStart: 0, rankInThreshold: null };

describe('hudGoalText', () => {
  it('seeded runs and replays show the high score', () => {
    expect(hudGoalText({ ...base, mode: 'hi', score: 1234, hiScore: 5000, bestAtStart: 5000, rankInThreshold: 9000 })).toBe(
      'HI 5000'
    );
  });

  it('at or below the best at the start of the run: points left to that best', () => {
    expect(hudGoalText({ ...base, score: 3800, hiScore: 5000, bestAtStart: 5000 })).toBe('TO BEST 1200');
    expect(hudGoalText({ ...base, score: 5000, hiScore: 5000, bestAtStart: 5000, rankInThreshold: 100 })).toBe('TO BEST 0');
  });

  it('past the best, board entry score known and not beaten: points left to the board', () => {
    expect(hudGoalText({ ...base, score: 5200, hiScore: 5200, bestAtStart: 5000, rankInThreshold: 6000 })).toBe('TO #10 800');
    expect(hudGoalText({ ...base, score: 6000, hiScore: 6000, bestAtStart: 5000, rankInThreshold: 6000 })).toBe('TO #10 0');
  });

  it('past the best and past the board entry score: TOP 10!', () => {
    expect(hudGoalText({ ...base, score: 6001, hiScore: 6001, bestAtStart: 5000, rankInThreshold: 6000 })).toBe('TOP 10!');
    // A board with a free row (threshold 0) takes any score.
    expect(hudGoalText({ ...base, score: 10, hiScore: 10, bestAtStart: 0, rankInThreshold: 0 })).toBe('TOP 10!');
  });

  it('past the best, board entry score unknown: NEW BEST!', () => {
    expect(hudGoalText({ ...base, score: 5001, hiScore: 5001, bestAtStart: 5000, rankInThreshold: null })).toBe('NEW BEST!');
  });

  it('with no best yet, the first point is already past it', () => {
    expect(hudGoalText({ ...base, score: 0, bestAtStart: 0 })).toBe('TO BEST 0');
    expect(hudGoalText({ ...base, score: 1, bestAtStart: 0 })).toBe('NEW BEST!');
  });
});
