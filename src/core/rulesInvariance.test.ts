// Rule invariance baseline: a fixed seed and a fixed scripted input list must
// keep producing exactly the same run — score, stages reached, lives, claims,
// board and elapsed ticks. Anything that alters the simulation (and so would
// change what an existing replay reproduces) fails here. The expected values
// were captured from the code before any presentation-only feedback was added
// to core and must not be edited to make a change pass.
import { describe, it, expect } from 'vitest';
import { runScriptedSession, ScriptedRunSummary } from './scriptedRun';

const BASELINE_CASES: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  expected: ScriptedRunSummary;
}> = [
  {
    name: 'small field, seed 20261114: occupancy clear, split clear, then gameover',
    options: { seed: 20261114, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 1084,
      stage: 3,
      lives: 0,
      claims: 14,
      misses: 3,
      splits: 1,
      totalTicks: 952,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '34165db5',
      eventsHash: '01cf13ad',
      stages: [
        { stage: 1, score: 678, lives: 3, totalTicks: 388, fieldHash: '29aacafd', split: false },
        { stage: 2, score: 972, lives: 2, totalTicks: 684, fieldHash: 'ced03e2d', split: true },
      ],
    },
  },
  {
    name: 'small field, seed 77: two split clears across four stages',
    options: { seed: 77, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 1910,
      stage: 4,
      lives: 0,
      claims: 10,
      misses: 3,
      splits: 2,
      totalTicks: 790,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '0a99a54d',
      eventsHash: '20cde565',
      stages: [
        { stage: 1, score: 706, lives: 2, totalTicks: 388, fieldHash: 'd23c45bd', split: false },
        { stage: 2, score: 958, lives: 1, totalTicks: 684, fieldHash: '82eedfd5', split: true },
        { stage: 3, score: 1910, lives: 1, totalTicks: 762, fieldHash: 'b3fdf7dd', split: true },
      ],
    },
  },
  {
    name: 'full-size field, seed 7: fast and slow claims until gameover',
    options: { seed: 7 },
    expected: {
      score: 4012,
      stage: 1,
      lives: 0,
      claims: 24,
      misses: 3,
      splits: 0,
      totalTicks: 4657,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: 'fbb8dedd',
      eventsHash: '96609815',
      stages: [],
    },
  },
];

describe('rule invariance baseline', () => {
  for (const { name, options, expected } of BASELINE_CASES) {
    it(name, () => {
      expect(runScriptedSession(options)).toEqual(expected);
    });
  }
});
