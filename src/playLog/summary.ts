// The play log's summary for the debug panel's PLAY LOG section: where runs
// end, how, what lives are lost to on each stage, the scores and the claims.
// DOM-free.
import { emptyMissTally, MISS_CAUSES, type MissTally, type PlayRecord } from './record';

export interface StageCount {
  stage: number;
  runs: number;
}

export interface StageMisses {
  stage: number;
  /** The runs that entered this stage. */
  runs: number;
  /** Lives lost on this stage, summed over those runs. */
  misses: MissTally;
}

export interface PlayLogSummary {
  runs: number;
  /** How many runs ended on each stage, by stage, ascending. */
  endByStage: StageCount[];
  endReasons: { life: number; time: number };
  /** Every stage any run entered, ascending. */
  missesByStage: StageMisses[];
  missesTotal: MissTally;
  /** The final scores: mean (rounded), median (the two middle ones' mean for an even count, not rounded, so it can end in .5) and best. All 0 with no runs. */
  score: { average: number; median: number; max: number };
  /** Claims (splits included) per run, to one decimal place. */
  claimsPerRun: number;
  /** Splits per run, to one decimal place. */
  splitsPerRun: number;
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function summarizePlayLog(runs: readonly PlayRecord[]): PlayLogSummary {
  const endByStage = new Map<number, number>();
  const missesByStage = new Map<number, StageMisses>();
  const missesTotal = emptyMissTally();
  const endReasons = { life: 0, time: 0 };
  let claims = 0;
  let splits = 0;

  for (const run of runs) {
    endByStage.set(run.stage, (endByStage.get(run.stage) ?? 0) + 1);
    endReasons[run.end]++;
    for (const tally of run.stages) {
      let entry = missesByStage.get(tally.stage);
      if (!entry) {
        entry = { stage: tally.stage, runs: 0, misses: emptyMissTally() };
        missesByStage.set(tally.stage, entry);
      }
      entry.runs++;
      for (const cause of MISS_CAUSES) {
        entry.misses[cause] += tally.misses[cause];
        missesTotal[cause] += tally.misses[cause];
      }
      claims += tally.claims;
      splits += tally.splits;
    }
  }

  const scores = runs.map((r) => r.score).sort((a, b) => a - b);
  const n = scores.length;
  const middle = Math.floor(n / 2);
  const score =
    n === 0
      ? { average: 0, median: 0, max: 0 }
      : {
          average: Math.round(scores.reduce((sum, s) => sum + s, 0) / n),
          median: n % 2 === 1 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2,
          max: scores[n - 1],
        };

  return {
    runs: n,
    endByStage: [...endByStage].map(([stage, count]) => ({ stage, runs: count })).sort((a, b) => a.stage - b.stage),
    endReasons,
    missesByStage: [...missesByStage.values()].sort((a, b) => a.stage - b.stage),
    missesTotal,
    score,
    claimsPerRun: n === 0 ? 0 : oneDecimal(claims / n),
    splitsPerRun: n === 0 ? 0 : oneDecimal(splits / n),
  };
}

/**
 * How many of the newest runs in a row ended on `stage` or earlier — counted
 * back from the newest (the last in `runs`) and stopping at the first that
 * got further.
 */
export function trailingRunsAtOrBelow(runs: readonly PlayRecord[], stage: number): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].stage > stage) break;
    count++;
  }
  return count;
}
