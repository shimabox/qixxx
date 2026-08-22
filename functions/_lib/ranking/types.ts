// Shared types for the D1-backed score-ranking endpoints. Dependency-free (like
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
  /** 'verified' is ranking-eligible; 'pending' is accepted but not yet audited. */
  status: 'verified' | 'pending';
  /** HMAC-SHA-256(CF-Connecting-IP) — null for rows backfilled from the pre-async-audit (always-verified) era, which predate this column. */
  ip_hash: string | null;
  audit_attempts: number;
  /** unixepoch()-scale seconds, or null — the D1-time-based retry gate. */
  next_attempt_at: number | null;
  /**
   * SHA-256 of the submitting browser's ownership token bytes. This is the
   * only value that lets a POST replace one of its own pending rows. Null
   * means no owner; verification clears it to avoid a durable identifier.
   */
  submitter_hash: string | null;
}

/**
 * The POST /api/scores request body (main.ts's ranking submission flow).
 *
 * score/stage are the client's claim (the server does not resimulate synchronously to
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
   * The submitting browser's ownership token: 32 lowercase hex characters = 16 random bytes,
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
 * One row of GET /api/ranking's `displayEntries`: the single merged
 * board the UI actually draws — verified rows plus the freshest few pending
 * ones, ordered by the same official rule (score DESC, rank_seq ASC) and
 * capped at 10.
 *
 * Deliberately an EXTENSION of RankingEntry rather than a parallel shape:
 * every field the UI already relies on (`replayAvailable` above all) is
 * present on a pending row too, so one rendering path — and one
 * `replayAvailable` check — covers both. `status` is the only addition, and
 * is limited to these two values and is not rendered:
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
 * A fresh pending row is
 * replayable now. The field reports which kind of row this is, for
 * operations and debugging; the viewer renders pending and verified replays identically.
 */
export interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
  status: 'pending' | 'verified';
}
