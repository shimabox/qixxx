import { describe, expect, it } from 'vitest';
import { summarizePlayLog, suggestsEasy, trailingRunsAtOrBelow } from './summary';
import { EASY_PROMPT_STREAK_RUNS, EASY_PROMPT_STREAK_STAGE } from '../config';
import type { PlayRecord, StageTally } from './record';

function stage(n: number, claims: number, splits: number, wisp: number, ember: number, igniter: number, cleared: boolean): StageTally {
  return { stage: n, claims, splits, misses: { wisp, ember, igniter }, cleared };
}

function run(stageReached: number, score: number, end: 'life' | 'time', stages: StageTally[]): PlayRecord {
  return { endedAt: 0, stage: stageReached, score, end, ticks: 100, stages };
}

describe('summarizePlayLog', () => {
  it('no runs: zeros everywhere', () => {
    expect(summarizePlayLog([])).toEqual({
      runs: 0,
      endByStage: [],
      endReasons: { life: 0, time: 0 },
      missesByStage: [],
      missesTotal: { wisp: 0, ember: 0, igniter: 0 },
      score: { average: 0, median: 0, max: 0 },
      claimsPerRun: 0,
      splitsPerRun: 0,
    });
  });

  it('one run', () => {
    const runs = [run(2, 1234, 'life', [stage(1, 5, 1, 1, 0, 0, true), stage(2, 2, 0, 1, 0, 1, false)])];
    expect(summarizePlayLog(runs)).toEqual({
      runs: 1,
      endByStage: [{ stage: 2, runs: 1 }],
      endReasons: { life: 1, time: 0 },
      missesByStage: [
        { stage: 1, runs: 1, misses: { wisp: 1, ember: 0, igniter: 0 } },
        { stage: 2, runs: 1, misses: { wisp: 1, ember: 0, igniter: 1 } },
      ],
      missesTotal: { wisp: 2, ember: 0, igniter: 1 },
      score: { average: 1234, median: 1234, max: 1234 },
      claimsPerRun: 7,
      splitsPerRun: 1,
    });
  });

  // Three runs (odd): ended on stages 1, 3, 1; one by time.
  const three = [
    run(1, 300, 'life', [stage(1, 4, 0, 2, 1, 0, false)]),
    run(3, 2000, 'time', [stage(1, 6, 0, 0, 0, 0, true), stage(2, 3, 1, 1, 0, 0, true), stage(3, 1, 0, 0, 0, 0, false)]),
    run(1, 101, 'life', [stage(1, 2, 0, 1, 1, 1, false)]),
  ];

  it('several runs, odd count: hand-counted values', () => {
    expect(summarizePlayLog(three)).toEqual({
      runs: 3,
      endByStage: [
        { stage: 1, runs: 2 },
        { stage: 3, runs: 1 },
      ],
      endReasons: { life: 2, time: 1 },
      // Stage 1 was entered by all three runs, stages 2 and 3 by one.
      missesByStage: [
        { stage: 1, runs: 3, misses: { wisp: 3, ember: 2, igniter: 1 } },
        { stage: 2, runs: 1, misses: { wisp: 1, ember: 0, igniter: 0 } },
        { stage: 3, runs: 1, misses: { wisp: 0, ember: 0, igniter: 0 } },
      ],
      missesTotal: { wisp: 4, ember: 2, igniter: 1 },
      // (300 + 2000 + 101) / 3 = 800.33; sorted 101, 300, 2000.
      score: { average: 800, median: 300, max: 2000 },
      // 16 claims / 3 = 5.33; 1 split / 3 = 0.33.
      claimsPerRun: 5.3,
      splitsPerRun: 0.3,
    });
  });

  it('several runs, even count: the median is the two middle scores’ mean, not rounded', () => {
    const four = [...three, run(2, 501, 'time', [stage(1, 1, 0, 0, 0, 0, true), stage(2, 0, 0, 0, 0, 0, false)])];
    const summary = summarizePlayLog(four);
    // Sorted 101, 300, 501, 2000: median (300 + 501) / 2 = 400.5 as is; only the mean is rounded, (2902) / 4 = 725.5 -> 726.
    expect(summary.score).toEqual({ average: 726, median: 400.5, max: 2000 });
    expect(summary.endByStage).toEqual([
      { stage: 1, runs: 2 },
      { stage: 2, runs: 1 },
      { stage: 3, runs: 1 },
    ]);
    expect(summary.endReasons).toEqual({ life: 2, time: 2 });
    expect(summary.missesByStage.map((s) => [s.stage, s.runs])).toEqual([
      [1, 4],
      [2, 2],
      [3, 1],
    ]);
    // 17 claims / 4 = 4.25 -> 4.3; 1 split / 4 = 0.25 -> 0.3.
    expect(summary.claimsPerRun).toBe(4.3);
    expect(summary.splitsPerRun).toBe(0.3);
  });
});

describe('trailingRunsAtOrBelow', () => {
  const ended = (stages: number[]) => stages.map((s) => run(s, 0, 'life', [stage(1, 0, 0, 0, 0, 0, false)]));

  it('counts the newest runs in a row that ended on the stage or earlier', () => {
    expect(trailingRunsAtOrBelow(ended([1, 2, 1, 2]), 2)).toBe(4);
    expect(trailingRunsAtOrBelow(ended([3, 1, 2, 1]), 2)).toBe(3);
  });

  it('stops at the first run that got further, counting back from the newest', () => {
    expect(trailingRunsAtOrBelow(ended([1, 1, 4, 2, 1]), 2)).toBe(2);
    expect(trailingRunsAtOrBelow(ended([1, 1, 1, 3]), 2)).toBe(0);
  });

  it('no runs: 0', () => {
    expect(trailingRunsAtOrBelow([], 2)).toBe(0);
  });
});

describe('suggestsEasy', () => {
  const ended = (stages: number[]) => stages.map((s) => run(s, 0, 'life', [stage(1, 0, 0, 0, 0, 0, false)]));

  it('suggests EASY from the third kept run in a row ending on stage 3 or earlier', () => {
    expect(EASY_PROMPT_STREAK_RUNS).toBe(3);
    expect(EASY_PROMPT_STREAK_STAGE).toBe(3);
    expect(suggestsEasy(ended([1]), true)).toBe(false);
    expect(suggestsEasy(ended([1, 3]), true)).toBe(false);
    expect(suggestsEasy(ended([1, 3, 2]), true)).toBe(true);
    expect(suggestsEasy(ended([3, 3, 3, 3]), true)).toBe(true);
  });

  it('starts counting again after a kept run reached stage 4', () => {
    expect(suggestsEasy(ended([1, 1, 1, 4]), true)).toBe(false);
    expect(suggestsEasy(ended([1, 1, 4, 1, 2]), true)).toBe(false);
    expect(suggestsEasy(ended([1, 1, 4, 1, 2, 3]), true)).toBe(true);
  });

  it('never suggests it for a run that was not kept', () => {
    expect(suggestsEasy(ended([1, 1, 1]), false)).toBe(false);
  });
});
