// Pure decision logic for which "run mode" the current game session is in.
// Distinguishes an ordinary run from a `?seed=<n>` run: a seeded run's
// board is a fixed, arbitrary layout (not the day-to-day varying normal
// one), so its score shouldn't be able to corrupt the normal mode's
// persisted record — the seed exists purely as a reproducible-board tool
// (e.g. the E2E claim scenario's fixed layout), not a "second" scoring
// track worth recording.
//
// Kept as a standalone, DOM-free module — unlike the rest of src/main.ts,
// which is DOM-only orchestration with no dedicated test file — specifically
// so this mode-selection logic has direct unit test coverage without
// needing a jsdom environment.

/**
 * - 'normal': an ordinary, unseeded run. Reads/writes `qixxx.highScore` normally.
 * - 'seeded': a `?seed=<n>` run. Reads (but never writes) `qixxx.highScore`.
 */
export type RunMode = 'normal' | 'seeded';

/** Whether `qixxx.highScore` may be *written* for a run in this mode. Reading/displaying it is always fine regardless of mode (main.ts calls session.getHighScore() directly). */
export function shouldPersistHighScore(mode: RunMode): boolean {
  return mode === 'normal';
}

/**
 * The HUD-line prefix identifying a non-'normal' run (main.ts's
 * updateHud()): `''` for 'normal' (byte-identical to before seeded-run
 * support existed), `SEED <n>  ` for 'seeded' — so a fixed/arbitrary-seed
 * board is never confused for the normal, day-to-day one.
 */
export function resolveHudModePrefix(mode: RunMode, params: { seededRunSeed: number | undefined }): string {
  return mode === 'seeded' ? `SEED ${params.seededRunSeed}  ` : '';
}
