// The on-device play log (src/playLog/record.ts): the newest
// PLAY_LOG_MAX_RUNS finished runs, oldest first, under one localStorage key
// as `{ "v": 1, "runs": [...] }`. Nothing here is ever sent anywhere.
//
// Best-effort, like src/storage/highscore.ts and src/storage/hints.ts: a
// storage that cannot be read, holds a broken value or cannot be written
// never throws. A broken value reads as no runs (runs that do not have the
// record's shape are dropped one by one), and runs added while the storage
// cannot be written are still kept in memory for this page load, so the
// debug panel's summary shows them.
import { PLAY_LOG_MAX_RUNS } from '../config';
import {
  MISS_CAUSES,
  PLAY_LOG_FORMAT_VERSION,
  type MissTally,
  type PlayLogFile,
  type PlayRecord,
  type StageTally,
} from '../playLog/record';
import type { StorageLike } from './hints';

export const PLAY_LOG_STORAGE_KEY = 'qixxx.playLog';

function defaultStorage(): StorageLike {
  return localStorage;
}

export class PlayLogStore {
  private readonly getStorage: () => StorageLike;
  private readonly maxRuns: number;
  private runs: PlayRecord[];

  /** `getStorage` defaults to localStorage; it may throw (no storage at all). */
  constructor(getStorage: () => StorageLike = defaultStorage, maxRuns = PLAY_LOG_MAX_RUNS) {
    this.getStorage = getStorage;
    this.maxRuns = maxRuns;
    this.runs = this.read();
  }

  /** The kept runs, oldest first (a copy). */
  list(): PlayRecord[] {
    return this.runs.map(copyRecord);
  }

  /** What is kept, as stored (`{ v: 1, runs }`, a copy). */
  toFile(): PlayLogFile {
    return { v: PLAY_LOG_FORMAT_VERSION, runs: this.list() };
  }

  /** Adds a run as the newest, dropping the oldest past the limit. */
  append(record: PlayRecord): void {
    this.runs.push(copyRecord(record));
    if (this.runs.length > this.maxRuns) this.runs.splice(0, this.runs.length - this.maxRuns);
    try {
      this.getStorage().setItem(PLAY_LOG_STORAGE_KEY, JSON.stringify(this.toFile()));
    } catch {
      // Best-effort persistence only — the runs are still kept in memory.
    }
  }

  /** Forgets every run, saved and in memory. */
  clear(): void {
    this.runs = [];
    try {
      this.getStorage().removeItem(PLAY_LOG_STORAGE_KEY);
    } catch {
      // Best-effort, as above.
    }
  }

  private read(): PlayRecord[] {
    try {
      const raw = this.getStorage().getItem(PLAY_LOG_STORAGE_KEY);
      if (raw === null) return [];
      const value: unknown = JSON.parse(raw);
      if (!isObject(value) || value.v !== PLAY_LOG_FORMAT_VERSION || !Array.isArray(value.runs)) return [];
      const runs: PlayRecord[] = [];
      for (const item of value.runs) {
        const record = parseRecord(item);
        if (record) runs.push(record);
      }
      return runs.slice(-this.maxRuns);
    } catch {
      return [];
    }
  }
}

function copyRecord(record: PlayRecord): PlayRecord {
  return { ...record, stages: record.stages.map((s) => ({ ...s, misses: { ...s.misses } })) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A stored run rebuilt with only the record's own fields, or null when it does not have their shape. */
function parseRecord(value: unknown): PlayRecord | null {
  if (!isObject(value)) return null;
  const { endedAt, stage, score, end, ticks, stages } = value;
  if (!isCount(endedAt) || !isCount(stage) || !isCount(score) || !isCount(ticks)) return null;
  if (end !== 'life' && end !== 'time') return null;
  if (!Array.isArray(stages)) return null;
  const parsedStages: StageTally[] = [];
  for (const item of stages) {
    const tally = parseStage(item);
    if (!tally) return null;
    parsedStages.push(tally);
  }
  return { endedAt, stage, score, end, ticks, stages: parsedStages };
}

function parseStage(value: unknown): StageTally | null {
  if (!isObject(value)) return null;
  const { stage, claims, splits, misses, cleared } = value;
  if (!isCount(stage) || !isCount(claims) || !isCount(splits) || typeof cleared !== 'boolean') return null;
  if (!isObject(misses)) return null;
  const tally = {} as MissTally;
  for (const cause of MISS_CAUSES) {
    const n = misses[cause];
    if (!isCount(n)) return null;
    tally[cause] = n;
  }
  return { stage, claims, splits, misses: tally, cleared };
}
