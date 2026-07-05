// localStorage-backed high-score persistence. DOM/localStorage-dependent by
// design — this lives outside src/core/ on purpose (docs/plan.md §4.4 /
// invariant: core never touches localStorage; core/session.ts only ever
// holds a plain number, seeded/persisted from here by main.ts).
//
// All localStorage access is wrapped in try/catch: it can throw in some
// environments (private browsing, disabled storage, storage quota, a
// non-browser test runner without a localStorage global, etc.) and a
// persistence failure should never crash the game — it should just silently
// no-op (docs/plan.md §3.9: localStorage only, best-effort, no server).
const HIGH_SCORE_STORAGE_KEY = 'qixxx.highScore';

/** Reads the persisted high score, or 0 if none is stored / storage is unavailable. */
export function loadHighScore(): number {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_STORAGE_KEY);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

/** Persists `value` as the new high score. No-ops (silently) if storage is unavailable. */
export function saveHighScore(value: number): void {
  try {
    localStorage.setItem(HIGH_SCORE_STORAGE_KEY, String(Math.floor(value)));
  } catch {
    // Best-effort persistence only — see the module comment above.
  }
}
