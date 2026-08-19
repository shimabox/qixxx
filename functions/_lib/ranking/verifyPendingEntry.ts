// verifyPendingEntry() — the async-audit-side verification layer
// (docs/plans/2026-08-19-ranking-free-async spec item 3). Wraps
// verifyReplay() (unchanged shape/signature/existing tests — see that
// module's own comment) and additionally classifies a mismatch between the
// *declared* values a pending row was stored with (score/stage/duration_ticks,
// ruleset_version/replay_format_version) and what a fresh resimulation +
// the server's CURRENT version constants actually produce, as an equally
// "confirmed invalid" result.
//
// This is deliberately its own function, not folded into verifyReplay()
// itself: verifyReplay()'s signature intentionally never took a declared
// score/stage/version (docs/plans/2026-08-16-score-ranking's original
// design — "バージョン判定は呼び出し側の責務"), and this task's spec item 3
// requires that contract stay exactly as-is (existing verifyReplay.test.ts
// must keep passing unmodified). verifyPendingEntry() is the "caller" that
// owns that responsibility for the async-audit path specifically — the
// synchronous POST path never needed it because it derived score/stage/
// duration itself instead of trusting a client claim.
//
// Error-propagation contract (spec item 3's confirmed "2層"): verifyReplay()
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
  /** The server's CURRENT values (season.ts's RULESET_VERSION/REPLAY_FORMAT_VERSION) at audit time — may have moved on since the row was accepted. */
  expectedRulesetVersion: number;
  expectedReplayFormatVersion: number;
  /** Bench-only hook, mirroring verifyReplay()'s own — always undefined in production/real audit runs. */
  benchHooks?: BenchVerifyHooks;
}

export function verifyPendingEntry(input: VerifyPendingEntryInput): VerifyPendingEntryResult {
  // Cheapest check first: a version that has already moved on since this row
  // was accepted is a confirmed-stale row, no resimulation needed to know
  // that.
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
