// Server-side replay verification (docs/plans/2026-08-16-score-ranking task
// 3's confirmed "verifyReplay() の分離" requirement): a DOM-non-dependent
// pure function so the exact same code can be called both from a synchronous
// POST /api/scores handler (functions/api/scores.ts) and, later, from a
// GitHub Actions-based async audit script (a future Free-tier alternative —
// see docs/plans/2026-08-16-score-ranking task 7) without duplicating the
// verification logic. Only depends on src/core/ (already DOM-free) and Web
// Crypto — nothing Cloudflare-Workers-specific, and nothing from functions/
// itself beyond this file's own imports, so it's trivially portable to a
// plain Node script too (Node 18+'s global `crypto`/TextEncoder cover
// everything this module and its core/ dependencies use).
import { simulateReplayFromRle, ReplayResult } from '../../../src/core/replayEngine';
import { GameOverReason } from '../../../src/core/session';
import { RleDecodeError } from '../../../src/core/rle';
import { TIME_LIMIT_TICKS, MAX_VERIFIED_CLAIMS } from '../../../src/config';
import type { BenchVerifyHooks } from './benchHooks';

export type VerifyReplayRejectionReason =
  | 'malformed-replay'
  | 'max-verified-claims-exceeded'
  | 'did-not-reach-gameover'
  | 'excess-input-after-gameover'
  | 'invalid-duration-for-time-ending'
  | 'invalid-duration-for-life-ending';

export interface VerifyReplayOk {
  ok: true;
  score: number;
  stage: number;
  durationTicks: number;
  totalClaims: number;
  gameOverReason: 'life' | 'time';
}

export interface VerifyReplayRejected {
  ok: false;
  reason: VerifyReplayRejectionReason;
}

export type VerifyReplayResult = VerifyReplayOk | VerifyReplayRejected;

/**
 * Re-simulates (seed, rle) via the shared core (src/core/replayEngine.ts's
 * simulateReplayFromRle()) and validates every server-side end condition
 * task 3 requires:
 *   - the RLE stream itself must decode cleanly (core/rle.ts validates
 *     while decoding — a malformed byte/varint/oversized sample count
 *     throws, caught here as 'malformed-replay')
 *   - claim count must never exceed MAX_VERIFIED_CLAIMS (checked via
 *     simulateReplayFromRle's onTick hook, so a violating replay is
 *     abandoned immediately rather than resimulated to completion)
 *   - the last input sample must actually reach 'gameover' — no more, no
 *     less: excess input past that point is rejected too
 *   - a 'time' ending must land at exactly TIME_LIMIT_TICKS; a 'life' ending
 *     must land strictly before it
 *
 * Deliberately does NOT check ruleset_version/replay_format_version/season —
 * those are simple equality comparisons the caller (functions/api/scores.ts)
 * already has everything it needs to make on its own, before ever paying for
 * a resimulation.
 */
export function verifyReplay(seed: number, rle: Uint8Array, benchHooks?: BenchVerifyHooks): VerifyReplayResult {
  let result: ReplayResult;
  try {
    result = simulateReplayFromRle(seed, rle, {
      onTick: ({ totalClaimsSoFar }) => totalClaimsSoFar > MAX_VERIFIED_CLAIMS,
      // Always undefined in production — see benchHooks.ts for the two locks
      // (a flag AND a live function on env, which no remote caller can set).
      // Present only so the CPU harness can measure the real handler instead
      // of a reimplementation of it.
      gameFactory: benchHooks?.gameFactory,
    });
  } catch (err) {
    // docs/plans/2026-08-19-ranking-free-async task 2's confirmed contract:
    // ONLY an RLE decode failure (src/core/rle.ts's RleDecodeError, thrown
    // while core/replayEngine.ts's simulateReplayFromRle() walks
    // decodeRleRuns()) is folded into the existing 'malformed-replay'
    // return value, preserving verifyReplay()'s external contract exactly
    // as verifyReplay.test.ts already requires. Any other exception (e.g. a
    // genuine bug deep inside GameSession) is NOT this function's to
    // classify — it propagates to the caller, which for the async-audit
    // caller (functions/_lib/ranking/verifyPendingEntry.ts / the audit
    // script) means "unexpected runtime error, retry later" rather than
    // "confirmed invalid replay, delete immediately".
    if (err instanceof RleDecodeError) {
      return { ok: false, reason: 'malformed-replay' };
    }
    throw err;
  }

  if (!result.reachedGameOver) {
    if (result.totalClaims > MAX_VERIFIED_CLAIMS) {
      return { ok: false, reason: 'max-verified-claims-exceeded' };
    }
    return { ok: false, reason: 'did-not-reach-gameover' };
  }
  if (result.excessSamplesAfterGameover > 0) {
    return { ok: false, reason: 'excess-input-after-gameover' };
  }

  const gameOverReason: GameOverReason = result.gameOverReason;
  if (gameOverReason === 'time' && result.durationTicks !== TIME_LIMIT_TICKS) {
    return { ok: false, reason: 'invalid-duration-for-time-ending' };
  }
  if (gameOverReason === 'life' && result.durationTicks >= TIME_LIMIT_TICKS) {
    return { ok: false, reason: 'invalid-duration-for-life-ending' };
  }
  // gameOverReason can't be null here: reachedGameOver being true means
  // GameSession.getGameOverReason() was set by the same call that flipped
  // status to 'gameover' (core/session.ts's update()), always to 'life' or
  // 'time'.
  return {
    ok: true,
    score: result.score,
    stage: result.stage,
    durationTicks: result.durationTicks,
    totalClaims: result.totalClaims,
    gameOverReason: gameOverReason as 'life' | 'time',
  };
}
