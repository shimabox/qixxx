import { describe, expect, it } from 'vitest';
import { playLogSummaryText } from './panel';
import type { PlayRecord } from '../playLog/record';

function run(stage: number, score: number, end: 'life' | 'time', misses: [number, number, number][]): PlayRecord {
  return {
    endedAt: 0,
    stage,
    score,
    end,
    ticks: 100,
    stages: misses.map(([wisp, ember, igniter], i) => ({ stage: i + 1, claims: 2, splits: i === 0 ? 1 : 0, misses: { wisp, ember, igniter }, cleared: i + 1 < stage })),
  };
}

describe('the PLAY LOG summary text', () => {
  it('no runs: NO RUNS YET', () => {
    expect(playLogSummaryText({ v: 1, runs: [] })).toBe('NO RUNS YET');
  });

  it('lists every item with its values', () => {
    const runs = [run(3, 900, 'time', [[0, 0, 0], [1, 0, 0], [1, 0, 0]]), run(1, 100, 'life', [[1, 1, 1]]), run(2, 500, 'life', [[2, 0, 0], [1, 0, 0]])];
    expect(playLogSummaryText({ v: 1, runs }).split('\n')).toEqual([
      'RUNS 3 / 50',
      'END STAGE',
      '  ST1 1  ST2 1  ST3 1',
      'END BY  LIFE 2  TIME 1',
      'MISSES',
      '  ST1  (runs 3)',
      '    WISP 3  EMBER 1  IGNITER 1',
      '  ST2  (runs 2)',
      '    WISP 2  EMBER 0  IGNITER 0',
      '  ST3  (runs 1)',
      '    WISP 1  EMBER 0  IGNITER 0',
      'SCORE',
      '  AVG 500  MED 500  MAX 900',
      'PER RUN',
      '  CLAIMS 4.0  SPLITS 1.0',
      // The newest two ended on stage 2 or earlier; the oldest got to 3.
      'STREAK ≤ ST2  2',
    ]);
  });

  it('SCORE shows an even count’s median as it is: .5 kept, a whole median without decimals', () => {
    const scoreLine = (scores: number[]) => {
      const lines = playLogSummaryText({ v: 1, runs: scores.map((s) => run(1, s, 'life', [[1, 0, 0]])) }).split('\n');
      return lines[lines.indexOf('SCORE') + 1];
    };
    // Sorted 100, 300, 501, 900: median (300 + 501) / 2 = 400.5; mean 1801 / 4 = 450.25 -> 450.
    expect(scoreLine([900, 300, 100, 501])).toBe('  AVG 450  MED 400.5  MAX 900');
    // Sorted 100, 300, 500, 900: median (300 + 500) / 2 = 400; mean 1800 / 4 = 450.
    expect(scoreLine([900, 300, 100, 500])).toBe('  AVG 450  MED 400  MAX 900');
  });
});
