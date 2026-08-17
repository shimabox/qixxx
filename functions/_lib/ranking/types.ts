// Shared types for the score-ranking feature's D1-backed endpoints
// (docs/plans/2026-08-16-score-ranking task 3). Dependency-free (like
// functions/_lib/types.ts) so it can be imported from the `functions/`
// tsconfig and, if it's ever reused there, a plain Node script alike.

/** A `scores` row as D1 returns it (migrations/0001_create_scores.sql). */
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
}

/** The POST /api/scores request body (main.ts's ranking submission flow, task 4). */
export interface ScoreSubmission {
  seed: number;
  rleBase64: string;
  name?: string;
  xHandle?: string;
  rulesetVersion: number;
  replayFormatVersion: number;
}

/** One row of GET /api/ranking's top-10 response. */
export interface RankingEntry {
  id: string;
  createdAt: string; // ISO 8601
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

/** GET /api/ranking/:id/replay's success response. */
export interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
}
