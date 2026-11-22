// localStorage-backed audio-mute persistence (docs/plan.md §3.8: "ミュート
// ボタンをHUDに置く（設定はlocalStorage保存）"), and the Title screen's
// NORMAL / EASY choice (src/core/difficulty.ts). DOM/localStorage-dependent
// by design — this lives outside src/core/ on purpose, mirroring
// src/storage/highscore.ts's pattern (core never touches localStorage; the
// audio layer only ever holds a plain boolean, seeded/persisted from here by
// main.ts).
//
// All localStorage access is wrapped in try/catch: it can throw in some
// environments (private browsing, disabled storage, storage quota, a
// non-browser test runner without a localStorage global, etc.) and a
// persistence failure should never crash the game — it should just silently
// no-op, exactly like highscore.ts.
import { parseDifficulty, type Difficulty } from '../core/difficulty';

const MUTED_STORAGE_KEY = 'qixxx.muted';
const DIFFICULTY_STORAGE_KEY = 'qixxx.difficulty';

/** The difficulty chosen on the Title screen, or NORMAL if none is stored / storage is unavailable. */
export function loadDifficulty(): Difficulty {
  try {
    return parseDifficulty(localStorage.getItem(DIFFICULTY_STORAGE_KEY));
  } catch {
    return 'normal';
  }
}

/** Persists `difficulty` as the Title screen's choice. No-ops (silently) if storage is unavailable. */
export function saveDifficulty(difficulty: Difficulty): void {
  try {
    localStorage.setItem(DIFFICULTY_STORAGE_KEY, difficulty);
  } catch {
    // Best-effort persistence only — see the module comment above.
  }
}

/**
 * Reads the persisted mute setting, or true if none is stored / storage is unavailable.
 * Defaults to muted (opt-in model): audio only plays if user explicitly saves 'false'.
 */
export function loadMuted(): boolean {
  try {
    const stored = localStorage.getItem(MUTED_STORAGE_KEY);
    // If explicitly stored as 'false' (user opted in for sound), respect that.
    // Otherwise (null or 'true'), default to true (muted).
    return stored !== 'false';
  } catch {
    // Storage unavailable — default to muted (safe side)
    return true;
  }
}

/** Persists `muted` as the new setting. No-ops (silently) if storage is unavailable. */
export function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_STORAGE_KEY, muted ? 'true' : 'false');
  } catch {
    // Best-effort persistence only — see the module comment above.
  }
}
