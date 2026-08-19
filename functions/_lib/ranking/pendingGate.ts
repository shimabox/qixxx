// Shared "is this score in TOP10 contention" gate (docs/plans/2026-08-19-
// ranking-free-async spec items 2 and 5) — used identically by:
//   - POST /api/scores's pre-pending gate (a claimed score that can't
//     possibly make the confirmed board is never stored as pending at all)
//   - GET /api/ranking's pendingEntries filter (a pending row is only shown
//     as "provisionally in range" if it still passes this same check)
// Kept as one function so the two call sites can never drift apart on the
// exact boundary condition.
import type { Env } from '../types';

/** Pending rows older than this are treated as expired everywhere they're counted/listed (spec item 7's "24時間超の期限切れを除外") — the actual DELETE happens at the audit job's own start (scripts/audit/), this constant only governs "ignore it" reads. */
export const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * The score a new submission must STRICTLY exceed to be pending-eligible /
 * shown in pendingEntries (spec items 2 and 5's confirmed
 * `COALESCE(10位スコア, -1)` rule): the current verified 10th-place score, or
 * -1 if fewer than 10 verified rows exist yet (unconditional pass, since
 * score is always >= 0).
 *
 * Computed directly in SQL (an OFFSET 9 read of the same verified-TOP10
 * ordering GET /api/ranking itself uses) rather than by first fetching the
 * top 10 and indexing into it in JS, so the two callers above share not just
 * the comparison but the exact query shape that produces its operand.
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

/** Spec items 2/5's confirmed comparison: the score must STRICTLY exceed the threshold — a tie with 10th place is out of range (first-come-first-served favors the incumbent already in `verified`). */
export function isWithinProvisionalRange(score: number, threshold: number): boolean {
  return score > threshold;
}
