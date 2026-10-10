-- Score ranking. Applied via
-- `wrangler d1 migrations apply qixxx-scores` — locally during development
-- (wrangler's local D1 emulation, no Cloudflare account action required),
-- and against the real D1 database only after the deployment runbook's
-- production safeguards have been completed (see docs/ranking-runbook.md).
--
-- Column notes:
-- - rank_seq: internal ordering tie-breaker. created_at plus UUID cannot
-- guarantee arrival order for equal timestamps, so AUTOINCREMENT guarantees
-- insertion order even for two rows with an identical created_at.
-- - id: the public-facing identifier (functions/_lib/shareId.ts's
-- generateShareId(), reused as-is — 16 random bytes, hex-encoded).
-- - season_id / ruleset_version / replay_format_version: deliberately
-- three separate columns (not folded together) so a rules-unchanged
-- season reset, a rules change, and a replay-encoding-only change can
-- each be reasoned about/queried independently. Ranking queries compare the
-- season and version columns together.
-- - x_handle: stored *without* a leading "@".
-- - inputs: the RLE-encoded PLAYING-tick input stream (core/rle.ts).
-- - replay_hash: UNIQUE — computed server-side from
-- season+rulesetVersion+seed+*normalized* inputs (not the raw received
-- BLOB), so re-submitting the same logical run under a different RLE run
-- -split can't bypass the uniqueness check (functions/_lib/ranking/hash.ts).
CREATE TABLE scores (
  rank_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  season_id INTEGER NOT NULL,
  ruleset_version INTEGER NOT NULL,
  replay_format_version INTEGER NOT NULL,
  score INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  name TEXT NOT NULL,
  x_handle TEXT,
  seed INTEGER NOT NULL,
  inputs BLOB NOT NULL,
  duration_ticks INTEGER NOT NULL,
  replay_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_scores_id ON scores(id);
CREATE UNIQUE INDEX idx_scores_replay_hash ON scores(replay_hash);

-- Serves both the top-10 ranking query (GET /api/ranking) and the POST
-- /api/scores batch's own "delete everything past rank 10" step. The shared
-- ordering is score DESC, rank_seq ASC.
CREATE INDEX idx_scores_season_ruleset_rank
  ON scores(season_id, ruleset_version, score DESC, rank_seq ASC);
