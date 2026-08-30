// verifyPendingEntry() is the async-audit-side verification layer. It wraps
// verifyReplay() and additionally classifies a mismatch between the
// *declared* values a pending row was stored with (score/stage/duration_ticks,
// ruleset_version/replay_format_version) and what a fresh resimulation +
// the server's CURRENT version constants actually produce, as an equally
// "confirmed invalid" result.
//
// This is deliberately its own function, not folded into verifyReplay()
// itself: verifyReplay() intentionally takes only (seed, rle) and never a
// declared score/stage/version, leaving those comparisons to its caller.
// verifyPendingEntry() is the caller that
// owns that responsibility for the async-audit path specifically — the
// synchronous POST path never needed it because it derived score/stage/
// duration itself instead of trusting a client claim.
//
// Error propagation has two layers: verifyReplay()
// itself has already absorbed the ONE kind of exception it is allowed to
// (src/core/rle.ts's RleDecodeError, converted to `{ok:false,
// reason:'malformed-replay'}`). Anything else verifyReplay() throws
// propagates straight out of this function too — this module adds no
// additional try/catch. The caller (the audit script) is the layer that
// decides "propagated exception -> retry via audit_attempts/next_attempt_at"
// vs. "ok:false return value -> confirmed invalid, delete immediately".
import { verifyReplay, VerifyReplayResult, VerifyReplayRejectionReason } from './verifyReplay';
import type { BenchVerifyHooks } from './benchHooks';

export type PendingMismatchReason =
  | VerifyReplayRejectionReason
  | 'season-mismatch'
  | 'ruleset-version-mismatch'
  | 'replay-format-version-mismatch'
  | 'declared-score-mismatch'
  | 'declared-stage-mismatch'
  | 'declared-duration-mismatch';

export interface VerifyPendingEntryOk {
  ok: true;
  score: number;
  stage: number;
  durationTicks: number;
  totalClaims: number;
  gameOverReason: 'life' | 'time';
}

export interface VerifyPendingEntryMismatch {
  ok: false;
  reason: PendingMismatchReason;
}

export type VerifyPendingEntryResult = VerifyPendingEntryOk | VerifyPendingEntryMismatch;

export interface VerifyPendingEntryInput {
  seed: number;
  rle: Uint8Array;
  /** What the pending row was stored with (POST time) — score/stage are the client's claim; durationTicks is the server-derived RLE-normalization value from POST time, being re-checked against a fresh derivation implicit in verifyReplay()'s resimulation. */
  declaredScore: number;
  declaredStage: number;
  declaredDurationTicks: number;
  declaredRulesetVersion: number;
  declaredReplayFormatVersion: number;
  /** The season the pending row was stamped with at POST time (server-assigned, never client-supplied — see season.ts). */
  declaredSeasonId: number;
  /** The server's CURRENT values (season.ts's CURRENT_SEASON_ID/RULESET_VERSION/REPLAY_FORMAT_VERSION) at audit time — may have moved on since the row was accepted. */
  expectedSeasonId: number;
  expectedRulesetVersion: number;
  expectedReplayFormatVersion: number;
  /** Bench-only hook, mirroring verifyReplay()'s own — always undefined in production/real audit runs. */
  benchHooks?: BenchVerifyHooks;
}

export function verifyPendingEntry(input: VerifyPendingEntryInput): VerifyPendingEntryResult {
  // Cheapest checks first: a season/version that has already moved on since
  // this row was accepted is a confirmed-stale row, no resimulation needed to
  // know that.
  //
  // The audit's pending fetch is deliberately season-agnostic — it must pick
  // up OLD seasons' leftover pending rows too, since nothing else ever
  // sweeps them — but confirming one as 'verified' would be wrong twice
  // over: the row can never appear in any ranking (every ranking/replay
  // query filters on `season_id = CURRENT_SEASON_ID AND ruleset_version =
  // RULESET_VERSION` together, see season.ts), and the TOP10 cleanup only
  // ever trims the CURRENT season, so it would sit there as an unreachable,
  // never-trimmed replay BLOB forever. A season bump with RULESET_VERSION
  // left unchanged (season.ts documents that as a supported "reset the
  // ranking" operation) is exactly the case the ruleset check alone misses.
  if (input.declaredSeasonId !== input.expectedSeasonId) {
    return { ok: false, reason: 'season-mismatch' };
  }
  if (input.declaredRulesetVersion !== input.expectedRulesetVersion) {
    return { ok: false, reason: 'ruleset-version-mismatch' };
  }
  if (input.declaredReplayFormatVersion !== input.expectedReplayFormatVersion) {
    return { ok: false, reason: 'replay-format-version-mismatch' };
  }

  const result: VerifyReplayResult = verifyReplay(input.seed, input.rle, input.benchHooks);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  if (result.score !== input.declaredScore) {
    return { ok: false, reason: 'declared-score-mismatch' };
  }
  if (result.stage !== input.declaredStage) {
    return { ok: false, reason: 'declared-stage-mismatch' };
  }
  if (result.durationTicks !== input.declaredDurationTicks) {
    return { ok: false, reason: 'declared-duration-mismatch' };
  }

  return {
    ok: true,
    score: result.score,
    stage: result.stage,
    durationTicks: result.durationTicks,
    totalClaims: result.totalClaims,
    gameOverReason: result.gameOverReason,
  };
}
