// One finished run in the on-device play log: how far it got, how it ended,
// and per stage what it claimed and what it lost lives to. Plain JSON values
// only, so a record is written to localStorage (src/storage/playLog.ts) and
// exported from the debug panel as it is.
//
// Deliberately small: no name, no ranking submitter id, no seed, no recorded
// inputs and nothing about the device or the browser.
import type { MissCause } from '../core/feedback';

/** How a run ended (GameSession.getGameOverReason()). */
export type PlayEnd = 'life' | 'time';

/** Lives lost in one stage, by what took them (MissFeedback.cause). */
export type MissTally = Record<MissCause, number>;

/** One stage of a run. */
export interface StageTally {
  stage: number;
  /** Areas closed in this stage, splits included. */
  claims: number;
  /** Of those, the ones that split the Wisps apart (0 or 1). */
  splits: number;
  misses: MissTally;
  /** The stage was cleared. */
  cleared: boolean;
}

export interface PlayRecord {
  /** When the run ended (Date.now() milliseconds). */
  endedAt: number;
  /** The stage the run ended on. */
  stage: number;
  /** The final score. */
  score: number;
  end: PlayEnd;
  /** Ticks the core was updated on while playing or on STAGE CLEAR (hit stops and pauses are not counted). */
  ticks: number;
  /** Every stage the run entered, from 1 in order. */
  stages: StageTally[];
}

/** What the play log keeps in storage: the runs, oldest first. */
export interface PlayLogFile {
  v: 1;
  runs: PlayRecord[];
}

export const PLAY_LOG_FORMAT_VERSION = 1;

export const MISS_CAUSES: readonly MissCause[] = ['wisp', 'ember', 'igniter'];

export function emptyMissTally(): MissTally {
  return { wisp: 0, ember: 0, igniter: 0 };
}
