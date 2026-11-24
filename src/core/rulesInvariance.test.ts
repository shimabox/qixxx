// Rule invariance baseline: a fixed seed and a fixed scripted input list must
// keep producing exactly the same run — score, stages reached, lives, claims,
// board and elapsed ticks. Anything that alters the simulation (and so would
// change what an existing replay reproduces) fails here. The expected values
// are the ruleset 2 baseline (RULESET_VERSION 2: the per-stage table as it is
// now — one Wisp on stages 1 and 2, so splits start on stage 3 — big claims,
// close calls, the split reward by the smaller side, the shorter post-miss
// wait, the marker start drawn from the middles of the four edges from stage
// 2, the Ember branch chase and Blaze cycle of the table, and the Wisp surge
// toward each stage's goal). Once a ruleset is published, its baseline must
// not be edited to make a change pass: a change that alters these runs needs
// a new ruleset.
//
// What each case covers (every one of them also reaches surge level 2 —
// checked below — so the pinned runs depend on the surge):
// - small field, seed 6471: occupancy clears (stages 1 and 2), a split clear
//   (stage 3), a run past stage 3, gameover, close calls and big claims.
// - small field, seed 704: occupancy clears (stages 1 and 2), a split clear
//   (stage 3), then a claim with a close call on stage 4 at the multiplier the
//   split raised, so the pinned scores depend on how it is applied. It has
//   close calls and big claims on the earlier stages too.
// - small field, seed 3542: occupancy clears (stages 1 and 2), a run to stage
//   3, gameover, close calls and big claims.
// - full-size field, seed 3249: a run that ends on stage 1, with fast and
//   slow claims and close calls, then gameover.
// No seed tried (1-20000 on the small field) makes the script split two
// stages in one run, so a single split is the baseline's. Of the twelve
// seeds that split on the small field (all on stage 3), only 704, 7086,
// 13061 and 14431 claim anything after the split (on stage 4), and 704 and
// 7086 with a close call. Between them, the multi-stage cases start their
// later stages on all four edges.
import { describe, it, expect } from 'vitest';
import { runScriptedSession, ScriptedRunSummary } from './scriptedRun';
import { RULESET_VERSION } from '../config';

const BASELINE_CASES: ReadonlyArray<{
  name: string;
  options: { seed: number; fieldWidth?: number; fieldHeight?: number };
  expected: ScriptedRunSummary;
}> = [
  {
    // Stage 2 starts on the left edge, stage 3 on the bottom, stage 4 on the right.
    name: 'small field, seed 6471: occupancy clears, a split clear on stage 3, then gameover on stage 4',
    options: { seed: 6471, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 4346,
      stage: 4,
      lives: 0,
      claims: 16,
      misses: 3,
      splits: 1,
      totalTicks: 936,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '0a99a54d',
      eventsHash: '7b517009',
      stages: [
        { stage: 1, score: 864, lives: 2, totalTicks: 421, fieldHash: '3cabe94d', split: false },
        { stage: 2, score: 4034, lives: 2, totalTicks: 625, fieldHash: 'c35dbe3d', split: false },
        { stage: 3, score: 4346, lives: 2, totalTicks: 798, fieldHash: 'c6ed033d', split: true },
      ],
    },
  },
  {
    // Stage 2 starts on the left edge, stage 3 on the top, stage 4 on the bottom.
    // Stage 4 plays at x2 and closes one fast line (56 cells) with a close call
    // before its last miss: 3632 -> 4088 (see the check below).
    name: 'small field, seed 704: occupancy clears, a split clear on stage 3, then a claim at x2 on stage 4',
    options: { seed: 704, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 4088,
      stage: 4,
      lives: 0,
      claims: 19,
      misses: 3,
      splits: 1,
      totalTicks: 1041,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: 'ab59bfcd',
      eventsHash: '4b9471d6',
      stages: [
        { stage: 1, score: 1102, lives: 2, totalTicks: 388, fieldHash: '29bf98c5', split: false },
        { stage: 2, score: 2697, lives: 2, totalTicks: 810, fieldHash: 'c539f47d', split: false },
        { stage: 3, score: 3632, lives: 2, totalTicks: 856, fieldHash: 'd6009935', split: true },
      ],
    },
  },
  {
    // Stage 2 starts on the top edge, stage 3 on the right.
    name: 'small field, seed 3542: two occupancy clears, then gameover on stage 3',
    options: { seed: 3542, fieldWidth: 40, fieldHeight: 30 },
    expected: {
      score: 4900,
      stage: 3,
      lives: 0,
      claims: 14,
      misses: 3,
      splits: 0,
      totalTicks: 817,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: '0a99a54d',
      eventsHash: '4d395da7',
      stages: [
        { stage: 1, score: 3449, lives: 2, totalTicks: 328, fieldHash: '6c770ecd', split: false },
        { stage: 2, score: 4900, lives: 1, totalTicks: 749, fieldHash: '0c9c0415', split: false },
      ],
    },
  },
  {
    name: 'full-size field, seed 3249: fast and slow claims on stage 1 until gameover',
    options: { seed: 3249 },
    expected: {
      score: 5474,
      stage: 1,
      lives: 0,
      claims: 31,
      misses: 3,
      splits: 0,
      totalTicks: 5868,
      status: 'gameover',
      gameOverReason: 'life',
      fieldHash: 'f9149475',
      eventsHash: '2159d5f9',
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
  { name: 'full-size field, seed 1', options: { seed: 1 }, whole: { score: 3763, stage: 1, totalTicks: 3823, fieldHash: '2c763fa5' } },
  { name: 'full-size field, seed 42', options: { seed: 42 }, whole: { score: 2419, stage: 1, totalTicks: 2931, fieldHash: '291fe4ed' } },
  { name: 'full-size field, seed 542', options: { seed: 542 }, whole: { score: 3953, stage: 1, totalTicks: 4190, fieldHash: '4b31ba79' } },
  {
    // A run that goes on past stage 1.
    name: 'small field, seed 1353',
    options: { seed: 1353, fieldWidth: 40, fieldHeight: 30 },
    stage1: { stage: 1, score: 2549, lives: 2, totalTicks: 138, fieldHash: 'ab896685', split: false },
  },
  {
    name: 'small field, seed 839',
    options: { seed: 839, fieldWidth: 40, fieldHeight: 30 },
    whole: { score: 210, stage: 1, totalTicks: 407, fieldHash: '0c84e8d5' },
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

  it('reaches Wisp surge level 2 in every case, so every pinned run goes through the surge', () => {
    for (const { options } of BASELINE_CASES) {
      let highest = 0;
      runScriptedSession({ ...options, onTick: (session) => (highest = Math.max(highest, session.getGame().getWispSurgeLevel())) });
      expect(highest, `seed ${options.seed}`).toBe(2);
    }
  });

  it("seed 704's pinned stage 4 points are its claim's x1 points doubled", () => {
    // Worked out by hand rather than through the scoring code: at x1 a fast
    // line is 0.5 points a cell, so 56 cells are 28, and a close call is 200
    // (stages 1 to 3 of this run score their 56-cell fast lines as 28, and
    // their close calls as 200). The split on stage 3 makes stage 4 x2.
    const atX1 = 56 * 0.5 + 200;
    const run = BASELINE_CASES.find((c) => c.options.seed === 704)!.expected;
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
