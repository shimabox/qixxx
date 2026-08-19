// score / stage validation for POST /api/scores (docs/plans/2026-08-19-
// ranking-free-async task 4's confirmed input contract: "クライアント申告は
// score と stage のみ...score は0以上、stage は1以上の厳密な整数"). Pure —
// no Request/D1 dependency — matching this directory's existing
// seedValidation.ts / nameValidation.ts pattern.
//
// Upper bounds (request.md's "未確定事項": "値域の上限は実装者裁量、根拠を
// コードコメントに記録すること"):
//
//   - MAX_SCORE = 999_999: matches src/config.ts's own documented HUD budget
//     (HUD_WORST_CASE_STATS_TEXT's "6-digit SCORE/HI (just under
//     1,000,000)") — that comment already treats a 7+-digit cumulative
//     score as an accepted residual the HUD sizing doesn't protect against,
//     so reusing the same ceiling here is a deliberate, already-precedented
//     line, not a new one invented for this task. A legitimate run's score
//     under normal play (SCORE_PER_CELL_FAST/SLOW * a 160x120 field, across
//     however many stages a 10800-tick/180s run realistically reaches) sits
//     far below this — the cap exists only to reject an obviously-impossible
//     claim value cheaply, before ever reaching pending storage or the async
//     audit.
//   - MAX_STAGE = 999: same source, the HUD budget's "3-digit STAGE".
//     core/stage.ts's difficulty curve plateaus at STAGE_MAX_DIFFICULTY (10)
//     and holds flat forever after, so nothing in core/ actually bounds how
//     many stages a sufficiently long/skilled run could clear in principle;
//     999 is generous headroom under the HUD's own display ceiling rather
//     than a gameplay-derived number.
//
// These are deliberately *generous* pre-pending sanity bounds, not the
// integrity check — verifyPendingEntry() (this directory) is what actually
// confirms a pending entry's declared score/stage against a resimulation
// during the async audit. Rejecting here only screens out obviously-bogus
// claims (negative, non-integer, or beyond either display ceiling) before
// they ever consume a pending slot.
export const MAX_SCORE = 999_999;
export const MAX_STAGE = 999;

export type ScoreValidationResult = { ok: true; value: number } | { ok: false; reason: string };

/** Validates a submitted score: an integer in [0, MAX_SCORE]. */
export function validateScore(raw: unknown): ScoreValidationResult {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, reason: 'score must be an integer' };
  }
  if (raw < 0 || raw > MAX_SCORE) {
    return { ok: false, reason: `score must be in [0, ${MAX_SCORE}]` };
  }
  return { ok: true, value: raw };
}

/** Validates a submitted stage: an integer in [1, MAX_STAGE]. */
export function validateStage(raw: unknown): ScoreValidationResult {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, reason: 'stage must be an integer' };
  }
  if (raw < 1 || raw > MAX_STAGE) {
    return { ok: false, reason: `stage must be in [1, ${MAX_STAGE}]` };
  }
  return { ok: true, value: raw };
}
