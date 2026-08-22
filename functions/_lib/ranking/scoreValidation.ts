// score / stage validation for POST /api/scores: client-reported values must be
// strict integers with score >= 0 and stage >= 1. Pure —
// no Request/D1 dependency — matching this directory's existing
// seedValidation.ts / nameValidation.ts pattern.
//
// UPPER BOUNDS: deliberately none beyond Number.isSafeInteger, because an
// upper bound is only sound when it is derived from a theoretical maximum.
// An earlier implementation capped score at 999_999 and stage at 999,
// reusing src/config.ts's HUD_WORST_CASE_STATS_TEXT sizing budget as the
// justification — which was simply the wrong source: that constant's own
// comment explicitly names "a 7+-digit cumulative score" as an ACCEPTED
// RESIDUAL the HUD layout does not protect against, i.e. the game itself
// treats a 7-digit score as reachable. Deriving a rejection threshold from a
// display-width budget therefore threw away legitimate high scores with a
// 400 before the audit ever saw them.
//
// The role split that makes an upper bound unnecessary here:
//
// - THIS layer (POST time) only screens out values that could not be a
// score/stage AT ALL — non-numbers, non-integers, negatives, a stage
// below 1, and anything outside the safe-integer range (past 2^53-1,
// arithmetic and JSON round-tripping stop being exact, so such a value
// is not a meaningful integer claim in the first place). Nothing here is
// an integrity check; the value is stored as a CLAIM on a 'pending' row
// that never appears in the confirmed ranking.
// - THE AUDIT (verifyPendingEntry(), this directory) is what actually
// decides truth: it resimulates the submitted replay and compares the
// derived score/stage against the declared ones, deleting the row on any
// mismatch ('declared-score-mismatch' / 'declared-stage-mismatch').
//
// So an absurd claim (9e15, say) needs no bound here — it takes the designed
// path: accepted as pending, then deleted by the audit as a confirmed
// mismatch. Estimating a "theoretical maximum" at POST time would only add a
// second, weaker, and independently-maintained copy of a judgement the
// resimulation already makes exactly.
export type ScoreValidationResult = { ok: true; value: number } | { ok: false; reason: string };

/** Validates a submitted score: a safe integer >= 0 (no upper bound — see this module's doc comment). */
export function validateScore(raw: unknown): ScoreValidationResult {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return { ok: false, reason: 'score must be a safe integer' };
  }
  if (raw < 0) {
    return { ok: false, reason: 'score must be >= 0' };
  }
  return { ok: true, value: raw };
}

/** Validates a submitted stage: a safe integer >= 1 (no upper bound — see this module's doc comment). */
export function validateStage(raw: unknown): ScoreValidationResult {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return { ok: false, reason: 'stage must be a safe integer' };
  }
  if (raw < 1) {
    return { ok: false, reason: 'stage must be >= 1' };
  }
  return { ok: true, value: raw };
}
