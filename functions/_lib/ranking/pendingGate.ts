// Shared boundaries for the asynchronous audit flow:
//
// 1. The 24h pending freshness boundary — one definition used by every reader and writer.
// 2. The verified-10th-place submission gate — the
// ONLY basis for whether a submission is accepted.
//
// Kept in one module so no call site can drift on either boundary.
import type { Env } from '../types';

/** The pending freshness window. */
export const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * The ONE cutoff every pending freshness/expiry decision is made against.
 * Given a "now" in epoch
 * milliseconds, returns `now - 24h`, also in epoch milliseconds (the unit
 * `scores.created_at` is stored in).
 *
 * The definition this cutoff carries, verbatim and everywhere:
 * - FRESH = `created_at > cutoff`
 * - EXPIRED = `created_at <= cutoff`
 *
 * Callers (all of them, deliberately — a new one must join this list rather
 * than restate the arithmetic):
 * - GET /api/ranking's displayEntries candidate filter (fresh only)
 * - POST /api/scores's pending-cap COUNT subqueries (fresh only, so a
 * stalled audit's backlog can't block new submissions)
 * - GET /api/ranking/:id/replay's judgement 2 (expired pending -> 404)
 * - the audit job's opening expired-pending sweep (expired -> DELETE)
 *
 * `now` is a parameter rather than an internal Date.now() call because the
 * audit job reasons about time using D1's OWN clock (its `runStartedAt`), not
 * the Node runner's.
 */
export function pendingFreshnessCutoff(nowMs: number): number {
  return nowMs - PENDING_EXPIRY_MS;
}

/** The expiry half of the boundary above for JS-side callers (`created_at <= cutoff`). */
export function isPendingExpired(createdAtMs: number, cutoffMs: number): boolean {
  return createdAtMs <= cutoffMs;
}

/**
 * The score a new submission must STRICTLY exceed to be stored as pending,
 * computed as `COALESCE(10位スコア, -1)`: the
 * current VERIFIED 10th-place score, or -1 if fewer than 10 verified rows
 * exist yet (unconditional pass, since score is always >= 0).
 *
 * Verified-only, deliberately: pending rows are visible on the merged board
 * (`displayEntries`) but must never raise this bar, or three fake pending
 * submissions could lock every honest player out of the ranking. The
 * anti-griefing tests preserve this separation.
 *
 * Computed directly in SQL (an OFFSET 9 read of the same verified-TOP10
 * ordering GET /api/ranking's `entries` itself uses) rather than by first
 * fetching the top 10 and indexing into it in JS, so the client-side and
 * server-side gates share not just the comparison but the exact query shape
 * that produces its operand.
 */
export async function getVerifiedTenthPlaceThreshold(env: Env, seasonId: number, rulesetVersion: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(
       (SELECT score FROM scores
        WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2
        ORDER BY score DESC, rank_seq ASC
        LIMIT 1 OFFSET 9),
       -1
     ) AS threshold`
  )
    .bind(seasonId, rulesetVersion)
    .first<{ threshold: number }>();
  return row?.threshold ?? -1;
}

/** The score must strictly exceed the threshold; a tie favors the incumbent already in `verified`. */
export function isWithinProvisionalRange(score: number, threshold: number): boolean {
  return score > threshold;
}
