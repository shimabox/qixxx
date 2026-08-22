// Shared types for the score-ranking feature's D1-backed endpoints
// (docs/plans/2026-08-16-score-ranking task 3). Dependency-free (like
// functions/_lib/types.ts) so it can be imported from the `functions/`
// tsconfig and, if it's ever reused there, a plain Node script alike.

/** A `scores` row as D1 returns it (migrations/0001_create_scores.sql, extended by migrations/0002_ranking_free_async.sql). */
export interface ScoreRow {
  rank_seq: number;
  id: string;
  season_id: number;
  ruleset_version: number;
  replay_format_version: number;
  score: number;
  stage: number;
  name: string;
  x_handle: string | null;
  seed: number;
  inputs: ArrayBuffer;
  duration_ticks: number;
  replay_hash: string;
  created_at: number;
  /** 'verified' (confirmed, ranking-eligible) or 'pending' (accepted but not yet audited) — docs/plans/2026-08-19-ranking-free-async spec item 13. */
  status: 'verified' | 'pending';
  /** HMAC-SHA-256(CF-Connecting-IP) — null for rows backfilled from the pre-async-audit (always-verified) era, which predate this column. */
  ip_hash: string | null;
  audit_attempts: number;
  /** unixepoch()-scale seconds, or null — spec item 7's D1-time-based retry gate. */
  next_attempt_at: number | null;
  /**
   * SHA-256 of the submitting browser's ownership token bytes
   * (functions/_lib/ranking/submitterToken.ts) — the ONLY thing that lets a
   * POST replace a pending row, and only ever one of its own. Null means "no
   * owner": a legacy row, a token-less client's row, or a row the audit has
   * already confirmed (the verified-flip clears it, so this never becomes a
   * durable browser identifier).
   */
  submitter_hash: string | null;
}

/**
 * The POST /api/scores request body (main.ts's ranking submission flow).
 *
 * docs/plans/2026-08-19-ranking-free-async spec item 1: score/stage are now
 * the client's claim (the server no longer resimulates synchronously to
 * derive them — that happens later, asynchronously, during the audit).
 * duration_ticks is deliberately NOT a field here: it is derived server-side
 * from the RLE stream's own sample count (functions/_lib/ranking/
 * rleDuration.ts), never trusted from the client.
 */
export interface ScoreSubmission {
  seed: number;
  rleBase64: string;
  score: number;
  stage: number;
  name?: string;
  xHandle?: string;
  rulesetVersion: number;
  replayFormatVersion: number;
  /**
   * The submitting browser's ownership token (docs/plans/2026-08-22-pending-
   * self-replace spec item 1): 32 lowercase hex characters = 16 random bytes,
   * persisted in localStorage by src/ui/submitterToken.ts.
   *
   * Optional on purpose, with THREE distinct meanings the server keeps apart:
   * present-and-well-formed enables self-replacement, ABSENT is an ordinary
   * old/private-browsing client that simply can't self-replace (never an
   * error), and present-but-malformed is a 400.
   */
  submitterToken?: string;
}

/** One row of GET /api/ranking's confirmed top-10 response — verified only, rank implied by array position. */
export interface RankingEntry {
  id: string;
  createdAt: string; // ISO 8601
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

/**
 * One row of GET /api/ranking's `displayEntries` (docs/plans/2026-08-19-
 * ranking-free-async spec item 5, 2026-08-20 revision): the SINGLE merged
 * board the UI actually draws — verified rows plus the freshest few pending
 * ones, ordered by the same official rule (score DESC, rank_seq ASC) and
 * capped at 10.
 *
 * Deliberately an EXTENSION of RankingEntry rather than a parallel shape:
 * every field the UI already relies on (`replayAvailable` above all) is
 * present on a pending row too, so one rendering path — and one
 * `replayAvailable` check — covers both. `status` is the only addition, and
 * is limited to these two values — and, since 2026-08-22, it is NOT rendered:
 * the UI draws pending and verified rows identically, and the field stays for
 * operations/debugging (e.g. reading a board state from curl).
 *
 * The array's own order IS the displayed ranking; there is no rank-number
 * field (and `rank_seq` itself never leaves the server — it is an internal
 * tie-break key only).
 */
export type DisplayRankingEntry = RankingEntry & { status: 'pending' | 'verified' };

/**
 * GET /api/ranking/:id/replay's success response.
 *
 * `status` (spec item 7's 2026-08-20 revision): a fresh pending row IS
 * replayable now. The field reports which kind of row this is, for
 * operations and debugging — the viewer itself does not render it (decision
 * of 2026-08-22: pending and verified replays look the same).
 */
export interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
  status: 'pending' | 'verified';
}
