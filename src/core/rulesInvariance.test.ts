// Rule invariance baseline: a fixed seed and a fixed scripted input list must
// keep producing exactly the same run — score, stages reached, lives, claims,
// board and elapsed ticks. Anything that alters the simulation (and so would
// change what an existing replay reproduces) fails here. The expected values
// are the ruleset 2 baseline (RULESET_VERSION 2: the per-stage table, big
// claims, close calls, the split reward by the smaller side and the shorter
// post-miss wait), captured when those rules were put in, and must not be
// edited to make a change pass. Each case's run includes close calls and big
// claims in its score.
import { describe, it, expect } from 'vitest';
import { runScriptedSession, ScriptedRunSummary } from './scriptedRun';
import { RULESET_VERSION } from '../config';

const BASELINE_CASES: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  expected: ScriptedRunSummary;
}> = [
  {
    name: 'small field, seed 1352: split clear, occupancy clear, then gameover',
    options: { seed: 1352, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 2688,
      stage: 3,
      lives: 0,
      claims: 11,
      misses: 3,
      splits: 1,
      totalTicks: 652,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '0a99a54d',
      eventsHash: '6a6c9fa8',
      stages: [
        { stage: 1, score: 1058, lives: 3, totalTicks: 171, fieldHash: '7d3d9a4d', split: true },
        { stage: 2, score: 2688, lives: 1, totalTicks: 624, fieldHash: 'b48e8025', split: false },
      ],
    },
  },
  {
    name: 'small field, seed 839: two split clears across three stages',
    options: { seed: 839, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 2015,
      stage: 3,
      lives: 0,
      claims: 10,
      misses: 3,
      splits: 2,
      totalTicks: 601,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '34165db5',
      eventsHash: '85e6e7ab',
      stages: [
        { stage: 1, score: 1023, lives: 3, totalTicks: 203, fieldHash: 'c35dbe3d', split: true },
        { stage: 2, score: 1903, lives: 2, totalTicks: 406, fieldHash: '6b0010cd', split: true },
      ],
    },
  },
  {
    name: 'full-size field, seed 120: fast and slow claims until gameover',
    options: { seed: 120 },
    expected: {
      score: 6005,
      stage: 1,
      lives: 0,
      claims: 32,
      misses: 3,
      splits: 0,
      totalTicks: 5944,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: 'a644be65',
      eventsHash: 'ef3f6b41',
      stages: [],
    },
  },
];

describe('rule invariance baseline', () => {
  it('is the baseline of ruleset 2', () => {
    expect(RULESET_VERSION).toBe(2);
  });

  for (const { name, options, expected } of BASELINE_CASES) {
    it(name, () => {
      expect(runScriptedSession(options)).toEqual(expected);
    });
  }
});
