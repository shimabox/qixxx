// Rule invariance baseline: a fixed seed and a fixed scripted input list must
// keep producing exactly the same run — score, stages reached, lives, claims,
// board and elapsed ticks. Anything that alters the simulation (and so would
// change what an existing replay reproduces) fails here. The expected values
// are the ruleset 2 baseline (RULESET_VERSION 2: the per-stage table, big
// claims, close calls, the split reward by the smaller side, the shorter
// post-miss wait and the marker start drawn from the middles of the four
// edges from stage 2), captured when those rules were put in, and must not
// be edited to make a change pass. Each multi-stage case's run includes
// close calls and big claims in its score, and starts its later stages on
// other edges than the top.
import { describe, it, expect } from 'vitest';
import { runScriptedSession, ScriptedRunSummary } from './scriptedRun';
import { RULESET_VERSION } from '../config';

const BASELINE_CASES: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  expected: ScriptedRunSummary;
}> = [
  {
    // Stage 2 starts on the left edge, stage 3 on the bottom.
    name: 'small field, seed 3627: split clear, occupancy clear, then gameover',
    options: { seed: 3627, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 2785,
      stage: 3,
      lives: 0,
      claims: 7,
      misses: 3,
      splits: 1,
      totalTicks: 524,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: 'c6ed033d',
      eventsHash: 'd628730e',
      stages: [
        { stage: 1, score: 224, lives: 2, totalTicks: 203, fieldHash: '6b0010cd', split: true },
        { stage: 2, score: 2473, lives: 1, totalTicks: 342, fieldHash: 'ab896685', split: false },
      ],
    },
  },
  {
    // Stage 2 starts on the left edge, stage 3 on the right.
    name: 'small field, seed 5481: two split clears across three stages',
    options: { seed: 5481, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 2966,
      stage: 3,
      lives: 0,
      claims: 9,
      misses: 3,
      splits: 2,
      totalTicks: 638,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '49137735',
      eventsHash: '66d25970',
      stages: [
        { stage: 1, score: 560, lives: 2, totalTicks: 388, fieldHash: '22e17845', split: true },
        { stage: 2, score: 2430, lives: 2, totalTicks: 435, fieldHash: 'd6009935', split: true },
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

// Stage 1 still starts at the middle of the top edge and draws nothing more
// from the rng, so its runs are the ones recorded before the start was
// randomized. A run that never leaves stage 1 matches as a whole; a longer
// one matches through the end of stage 1.
const STAGE_1_BEFORE_RANDOM_STARTS: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  whole?: Pick<ScriptedRunSummary, 'score' | 'stage' | 'totalTicks' | 'fieldHash'>;
  stage1?: ScriptedRunSummary['stages'][number];
}> = [
  { name: 'full-size field, seed 1', options: { seed: 1 }, whole: { score: 649, stage: 1, totalTicks: 886, fieldHash: '82729ee5' } },
  { name: 'full-size field, seed 42', options: { seed: 42 }, whole: { score: 1475, stage: 1, totalTicks: 2228, fieldHash: 'b07f6b25' } },
  {
    name: 'full-size field, seed 542',
    options: { seed: 542 },
    stage1: { stage: 1, score: 13793, lives: 3, totalTicks: 681, fieldHash: '76e8d171', split: true },
  },
  {
    name: 'small field, seed 1352',
    options: { seed: 1352, fieldWidth: 40, fieldHeight: 30 },
    stage1: { stage: 1, score: 1058, lives: 3, totalTicks: 171, fieldHash: '7d3d9a4d', split: true },
  },
  {
    name: 'small field, seed 839',
    options: { seed: 839, fieldWidth: 40, fieldHeight: 30 },
    stage1: { stage: 1, score: 1023, lives: 3, totalTicks: 203, fieldHash: 'c35dbe3d', split: true },
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

describe('stage 1 is unchanged by the randomized stage starts', () => {
  for (const { name, options, whole, stage1 } of STAGE_1_BEFORE_RANDOM_STARTS) {
    it(name, () => {
      const run = runScriptedSession(options);
      if (whole) expect(run).toMatchObject({ ...whole, stages: [] });
      if (stage1) expect(run.stages[0]).toEqual(stage1);
    });
  }
});
