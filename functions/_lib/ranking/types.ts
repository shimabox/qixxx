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
 * One row of GET /api/ranking's `pendingEntries` (docs/plans/2026-08-19-
 * ranking-free-async spec item 5): deliberately carries no rank number — the
 * UI renders these as an unranked "検証待ち" list above the confirmed board,
 * never inserted into it. `id` is included only for a stable UI list key
 * (it is already a public identifier elsewhere); it grants no extra access —
 * GET /api/ranking/:id/replay is verified-only regardless of whether the
 * caller learned an id from here.
 */
export interface PendingRankingEntry {
  id: string;
  createdAt: string; // ISO 8601
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  unverified: true;
}

/** GET /api/ranking/:id/replay's success response. */
export interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
}
