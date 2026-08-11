// localStorage-backed DAILY-challenge best-score persistence + cleanup
// (docs/plans/2026-08-11-daily-seed-time-attack request task 3). DOM/
// localStorage-dependent by design — lives outside src/core/ on purpose,
// mirroring src/storage/highscore.ts's pattern (core never touches
// localStorage; core/session.ts stays entirely unaware that "daily" is even
// a concept — main.ts is what threads a date-derived seed into
// SessionOptions.seed and reads/writes this module).
//
// Every daily best is stored under its own per-date key
// (`qixxx.daily.<YYYY-MM-DD>.best`) rather than a single mutable "today's
// best" key, so a stale tab left open across a day boundary can't clobber a
// different day's record; cleanupOldDailyKeys() below is what reclaims
// yesterday's (and older) keys instead, run once at startup.
//
// All localStorage access is wrapped in try/catch, exactly like
// highscore.ts: it can throw in some environments (private browsing,
// disabled storage, storage quota, a non-browser test runner without a
// localStorage global, etc.) and a persistence failure should never crash
// the game — it should just silently no-op.
const DAILY_KEY_PREFIX = 'qixxx.daily.';
const DAILY_KEY_SUFFIX = '.best';

function dailyBestKey(date: string): string {
  return `${DAILY_KEY_PREFIX}${date}${DAILY_KEY_SUFFIX}`;
}

/**
 * Today's date as `YYYY-MM-DD` in JST (UTC+9, no DST — Japan doesn't
 * observe one), regardless of the machine/browser's own local timezone, so
 * every player worldwide who opens the game during the same JST calendar
 * day gets the same DAILY seed/board (docs/plans/2026-08-11-daily-seed-
 * time-attack request task 4: "日付境界は JST 0時"). Accepts an optional
 * `date` (defaulting to `new Date()`) purely for testability — production
 * call sites always omit it.
 */
export function getJstDateString(date: Date = new Date()): string {
  const jstMs = date.getTime() + 9 * 60 * 60 * 1000; // UTC+9, fixed offset
  const jst = new Date(jstMs);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Reads `date`'s persisted DAILY best score, or 0 if none is stored / storage is unavailable. */
export function loadDailyBest(date: string): number {
  try {
    const raw = localStorage.getItem(dailyBestKey(date));
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

/**
 * Persists `score` as `date`'s new DAILY best if — and only if — it beats
 * (is strictly higher than) whatever's already recorded. Returns whether
 * this call actually set a new record. No-ops (returning false) silently if
 * storage is unavailable. Never touches `qixxx.highScore` (src/storage/
 * highscore.ts) — the two are intentionally kept on completely separate
 * keys so a DAILY run's (necessarily different, date-seeded) board can
 * never taint the ordinary high score.
 */
export function saveDailyBestIfBetter(date: string, score: number): boolean {
  try {
    const existing = loadDailyBest(date);
    if (score <= existing) return false;
    localStorage.setItem(dailyBestKey(date), String(Math.floor(score)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every `qixxx.daily.*.best` key except `currentDate`'s
 * (docs/plans/2026-08-11-daily-seed-time-attack request task 3: "起動時に
 * 過去日付のデイリーキーを掃除する"), best-effort. Intended to be called
 * once at startup (main.ts's init()) so a browser that's been left open (or
 * revisited) across many days doesn't accumulate one best-score key per day
 * forever.
 */
export function cleanupOldDailyKeys(currentDate: string): void {
  try {
    const keepKey = dailyBestKey(currentDate);
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DAILY_KEY_PREFIX) && key.endsWith(DAILY_KEY_SUFFIX) && key !== keepKey) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // Best-effort cleanup only — see the module comment above.
  }
}
