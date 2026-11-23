// Rule invariance baseline: a fixed seed and a fixed scripted input list must
// keep producing exactly the same run — score, stages reached, lives, claims,
// board and elapsed ticks. Anything that alters the simulation (and so would
// change what an existing replay reproduces) fails here. The expected values
// are the ruleset 2 baseline (RULESET_VERSION 2: the per-stage table as it is
// now — one Wisp on stages 1 and 2, so splits start on stage 3 — big claims,
// close calls, the split reward by the smaller side, the shorter post-miss
// wait, the marker start drawn from the middles of the four edges from stage
// 2, and the Ember branch chase and Blaze cycle of the table). Once a ruleset
// is published, its baseline must not be edited to make a change pass: a
// change that alters these runs needs a new ruleset.
//
// What each case covers:
// - small field, seed 10505: occupancy clears (stages 1 and 2), a split clear
//   (stage 3), a run past stage 3, gameover, close calls and big claims.
// - small field, seed 699: occupancy clears (stages 1 and 2), a split clear
//   (stage 3), then a claim with a close call on stage 4 at the multiplier the
//   split raised, so the pinned scores depend on how it is applied.
// - small field, seed 735: occupancy clears (stages 1 and 2), a run to stage
//   3, gameover, close calls and big claims.
// - full-size field, seed 3246: a run that ends on stage 1, with fast and
//   slow claims and close calls, then gameover.
// No seed tried (1-20000 on the small field, 1-20000 on the full-size one)
// makes the script split two stages in one run, so a single split is the
// baseline's. Of the seven seeds that split on the small field, only 699 and
// 12679 claim anything after the split (each one line on stage 4). Between
// them, the multi-stage cases start their later stages on all four edges.
import { describe, it, expect } from 'vitest';
import { runScriptedSession, ScriptedRunSummary } from './scriptedRun';
import { RULESET_VERSION } from '../config';

const BASELINE_CASES: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  expected: ScriptedRunSummary;
}> = [
  {
    // Stage 2 starts on the left edge, stage 3 on the bottom, stage 4 on the left.
    name: 'small field, seed 10505: occupancy clears, a split clear on stage 3, then gameover on stage 4',
    options: { seed: 10505, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 2465,
      stage: 4,
      lives: 0,
      claims: 14,
      misses: 3,
      splits: 1,
      totalTicks: 843,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '0a99a54d',
      eventsHash: '0e3bdf9d',
      stages: [
        { stage: 1, score: 878, lives: 3, totalTicks: 388, fieldHash: '29aacafd', split: false },
        { stage: 2, score: 2269, lives: 2, totalTicks: 592, fieldHash: '2644b3cd', split: false },
        { stage: 3, score: 2465, lives: 1, totalTicks: 798, fieldHash: '9f4c7085', split: true },
      ],
    },
  },
  {
    // Stage 2 starts on the right edge, stage 3 on the top, stage 4 on the left.
    // Stage 4 plays at x2 and closes one fast line (56 cells) with a close call
    // before its last miss: 4552 -> 5008 (see the check below).
    name: 'small field, seed 699: occupancy clears, a split clear on stage 3, then a claim at x2 on stage 4',
    options: { seed: 699, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 5008,
      stage: 4,
      lives: 0,
      claims: 17,
      misses: 3,
      splits: 1,
      totalTicks: 947,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: 'ab59bfcd',
      eventsHash: '50124b66',
      stages: [
        { stage: 1, score: 934, lives: 2, totalTicks: 388, fieldHash: 'ce95a14d', split: false },
        { stage: 2, score: 3904, lives: 2, totalTicks: 625, fieldHash: 'c35dbe3d', split: false },
        { stage: 3, score: 4552, lives: 1, totalTicks: 888, fieldHash: 'cfbde0f5', split: true },
      ],
    },
  },
  {
    // Stage 2 starts on the bottom edge, stage 3 on the left.
    name: 'small field, seed 735: two occupancy clears, then gameover on stage 3',
    options: { seed: 735, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 5698,
      stage: 3,
      lives: 0,
      claims: 14,
      misses: 3,
      splits: 0,
      totalTicks: 811,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '9f4c7085',
      eventsHash: '6ba5186f',
      stages: [
        { stage: 1, score: 1681, lives: 2, totalTicks: 453, fieldHash: '0c9c0415', split: false },
        { stage: 2, score: 5302, lives: 2, totalTicks: 626, fieldHash: '7d1f217d', split: false },
      ],
    },
  },
  {
    name: 'full-size field, seed 3246: fast and slow claims on stage 1 until gameover',
    options: { seed: 3246 },
    expected: {
      score: 6582,
      stage: 1,
      lives: 0,
      claims: 32,
      misses: 3,
      splits: 0,
      totalTicks: 5598,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '36e7f4ed',
      eventsHash: 'bba561f9',
      stages: [],
    },
  },
];

// Stage 1 always starts at the middle of the top edge and has one Wisp, so a
// seed's stage 1 is one fixed run, pinned here. A run that never leaves stage
// 1 matches as a whole; a longer one matches through the end of stage 1.
const STAGE_1_RUNS: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  whole?: Pick<ScriptedRunSummary, 'score' | 'stage' | 'totalTicks' | 'fieldHash'>;
  stage1?: ScriptedRunSummary['stages'][number];
}> = [
  { name: 'full-size field, seed 1', options: { seed: 1 }, whole: { score: 4117, stage: 1, totalTicks: 4127, fieldHash: 'b8b7e299' } },
  { name: 'full-size field, seed 42', options: { seed: 42 }, whole: { score: 2419, stage: 1, totalTicks: 2931, fieldHash: '291fe4ed' } },
  { name: 'full-size field, seed 542', options: { seed: 542 }, whole: { score: 3835, stage: 1, totalTicks: 4059, fieldHash: '32e42f91' } },
  {
    name: 'small field, seed 1352',
    options: { seed: 1352, fieldWidth: 40, fieldHeight: 30 },
    stage1: { stage: 1, score: 1709, lives: 1, totalTicks: 453, fieldHash: '99963735', split: false },
  },
  {
    name: 'small field, seed 839',
    options: { seed: 839, fieldWidth: 40, fieldHeight: 30 },
    whole: { score: 210, stage: 1, totalTicks: 404, fieldHash: '0c84e8d5' },
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

  it("seed 699's pinned stage 4 points are its claim's x1 points doubled", () => {
    // Worked out by hand rather than through the scoring code: at x1 a fast
    // line is 0.5 points a cell, so 56 cells are 28, and a close call is 200
    // (stages 1 to 3 of this run score their 56-cell fast lines as 28, and
    // their close calls as 200). The split on stage 3 makes stage 4 x2.
    const atX1 = 56 * 0.5 + 200;
    const run = BASELINE_CASES.find((c) => c.options.seed === 699)!.expected;
    expect(run.stages.map((s) => s.split)).toEqual([false, false, true]);
    expect(run.score - run.stages[2].score).toBe(2 * atX1);
  });
});

describe("stage 1's run is fixed by the seed", () => {
  for (const { name, options, whole, stage1 } of STAGE_1_RUNS) {
    it(name, () => {
      const run = runScriptedSession(options);
      if (whole) expect(run).toMatchObject({ ...whole, stages: [] });
      if (stage1) expect(run.stages[0]).toEqual(stage1);
    });
  }
});
