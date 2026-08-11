// Pure decision logic for which "run mode" the current game session is in
// (docs/plans/2026-08-11-daily-seed-time-attack, 2026-08-11 cross-review
// fix): distinguishes a genuine DAILY run (started via the DAILY button —
// always today's JST-date-derived board, or an explicit `?seed=` value the
// player chose to play *as* today's DAILY challenge) from an arbitrary
// `?seed=<n>` run started by a normal key/tap (NOT the DAILY button). The
// latter must never be treated as DAILY: its score must not overwrite
// `qixxx.daily.<date>.best` (that key means "today's actual DAILY board's
// best", not "whatever board someone happened to load"), and its HUD must
// not falsely claim `DAILY <date>`.
//
// Kept as a standalone, DOM-free module — unlike the rest of src/main.ts,
// which is DOM-only orchestration with no dedicated test file — specifically
// so this mode-selection logic (the exact thing the cross-review flagged)
// has direct unit test coverage without needing a jsdom environment.

/**
 * - 'normal': an ordinary, unseeded run. Reads/writes `qixxx.highScore` and
 *   `qixxx.bestTimes` normally.
 * - 'seeded': a `?seed=<n>` run started by a normal key/tap (not the DAILY
 *   button). Reads (but never writes) `qixxx.highScore`; never touches
 *   `qixxx.daily.*` or `qixxx.bestTimes` — the board isn't the normal one,
 *   and it isn't necessarily today's actual DAILY board either.
 * - 'daily': a run started via the DAILY button (using `?seed=` as the seed
 *   value if present, else today's JST-date-derived seed). Reads/writes
 *   `qixxx.daily.<date>.best`; never touches `qixxx.highScore` or
 *   `qixxx.bestTimes`.
 */
export type RunMode = 'normal' | 'seeded' | 'daily';

/** Whether `qixxx.highScore` may be *written* for a run in this mode. Reading/displaying it is a separate question — see resolveDisplayHighScore(). */
export function shouldPersistHighScore(mode: RunMode): boolean {
  return mode === 'normal';
}

/**
 * Whether `qixxx.daily.<date>.best` may be written for a run in this mode.
 * Only 'daily' — this is the exact guarantee the cross-review fix exists
 * for: an arbitrary 'seeded' run must never be able to overwrite the day's
 * real DAILY record with an unrelated board's score.
 */
export function shouldPersistDailyBest(mode: RunMode): boolean {
  return mode === 'daily';
}

/**
 * Whether `qixxx.bestTimes` may be written for a stage clear in this mode.
 * Neither a 'seeded' nor a 'daily' board is the normal one, so neither
 * produces a comparable "best" (unchanged from the original request.md
 * task 4 behavior — the cross-review only flagged daily-best/HUD-label
 * mislabeling, not this).
 */
export function shouldPersistBestTime(mode: RunMode): boolean {
  return mode === 'normal';
}

/**
 * Decides what a normal key/tap confirming a Title screen should do, given
 * the *current* run's mode and whether `?seed=` pinned this whole page load
 * (`explicitSeedParam !== undefined`). Only ever returns 'normal' or
 * 'seeded' — a normal key/tap can never (re)start a 'daily' run; only
 * clicking the DAILY button does that.
 *
 * - 'normal' or 'seeded' currently active: unchanged. `GameSession`'s own
 *   internal reset (triggered by its 'gameover' case) already reuses the
 *   same seed (or lack thereof) across every retry — no swap needed.
 * - 'daily' currently active: falls back to 'seeded' if `?seed=` pinned the
 *   page load (keeping the fixed board reproducible for further retries
 *   without mislabeling it DAILY), otherwise falls back to a fresh
 *   'normal' run (request.md task 4: "それ以外のキー/タップは従来どおり
 *   通常モード開始").
 */
export function resolveTitleConfirmRunMode(currentMode: RunMode, explicitSeedParam: number | undefined): RunMode {
  if (currentMode !== 'daily') {
    return currentMode;
  }
  return explicitSeedParam !== undefined ? 'seeded' : 'normal';
}

/**
 * The "HI"/"HI SCORE" value to display for a run in this mode (main.ts's
 * getDisplayHighScore()): 'daily' shows the separate DAILY best (never
 * mixing in `qixxx.highScore`); every other mode shows the session's own
 * ordinary high score — read-only for 'seeded' (see shouldPersistHighScore
 * for why the write is still suppressed).
 */
export function resolveDisplayHighScore(
  mode: RunMode,
  params: { dailyBestAtRunStart: number; currentScore: number; sessionHighScore: number }
): number {
  return mode === 'daily' ? Math.max(params.dailyBestAtRunStart, params.currentScore) : params.sessionHighScore;
}

/**
 * The HUD-line prefix identifying a non-'normal' run (main.ts's
 * updateHud()): `''` for 'normal' (byte-identical to before this feature
 * existed), `DAILY <date>  ` for 'daily', `SEED <n>  ` for 'seeded' — so an
 * arbitrary-seed run is never confused for the real DAILY board.
 */
export function resolveHudModePrefix(
  mode: RunMode,
  params: { dailyDateStr: string; seededRunSeed: number | undefined }
): string {
  if (mode === 'daily') return `DAILY ${params.dailyDateStr}  `;
  if (mode === 'seeded') return `SEED ${params.seededRunSeed}  `;
  return '';
}
