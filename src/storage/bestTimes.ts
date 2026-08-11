// localStorage-backed per-stage best-time persistence (docs/plans/2026-08-11-
// daily-seed-time-attack request task 3: TIME ATTACK). DOM/localStorage-
// dependent by design — lives outside src/core/ on purpose, mirroring
// src/storage/highscore.ts's pattern (core never touches localStorage;
// core/session.ts only ever exposes a plain tick count via getStageTicks(),
// persisted from here by main.ts). Times are measured in ticks (60 tick = 1s
// at config.ts's TICK_RATE), never wall-clock time — see session.ts's tick
// timer for why.
//
// All localStorage access is wrapped in try/catch, exactly like
// highscore.ts: it can throw in some environments (private browsing,
// disabled storage, storage quota, a non-browser test runner without a
// localStorage global, etc.) and a persistence failure should never crash
// the game — it should just silently no-op.
const BEST_TIMES_STORAGE_KEY = 'qixxx.bestTimes';

/** Stage number -> best clear time for that stage, in ticks. */
export type BestTimes = Record<number, number>;

/**
 * Reads every persisted per-stage best time, or `{}` if none is stored /
 * storage is unavailable / the stored JSON is malformed. Malformed or
 * out-of-range entries (non-finite, negative, a non-numeric stage key) are
 * dropped individually rather than discarding the whole map, so a single
 * corrupted entry can't wipe out every other stage's recorded best.
 */
export function loadBestTimes(): BestTimes {
  try {
    const raw = localStorage.getItem(BEST_TIMES_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};

    const result: BestTimes = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const stage = Number(key);
      if (!Number.isFinite(stage) || stage <= 0) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      result[stage] = Math.floor(value);
    }
    return result;
  } catch {
    return {};
  }
}

/** Reads stage `stage`'s persisted best time (ticks), or `null` if none is recorded / storage is unavailable. */
export function loadBestTime(stage: number): number | null {
  const times = loadBestTimes();
  return times[stage] ?? null;
}

/**
 * Persists `ticks` as stage `stage`'s new best time if — and only if — it
 * beats (is strictly lower than) whatever's already recorded. Returns
 * whether this call actually set a new record, so callers (main.ts's
 * StageClear screen) know whether to show "NEW RECORD!" without a second
 * read. No-ops (returning false) silently if storage is unavailable.
 */
export function saveBestTimeIfBetter(stage: number, ticks: number): boolean {
  try {
    const times = loadBestTimes();
    const existing = times[stage];
    if (existing !== undefined && existing <= ticks) return false;
    times[stage] = Math.floor(ticks);
    localStorage.setItem(BEST_TIMES_STORAGE_KEY, JSON.stringify(times));
    return true;
  } catch {
    return false;
  }
}
