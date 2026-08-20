-- Free-tier async-audit ranking (docs/plans/2026-08-19-ranking-free-async
-- task 3). Applied the same way as migrations/0001_create_scores.sql: via
-- `wrangler d1 migrations apply qixxx-scores` — locally against wrangler's
-- local D1 emulation during this round's development, and against the real
-- D1 database only once a future round's own stop point is cleared (see
-- docs/ranking-runbook.md). This migration is additive-only: no existing
-- column is dropped/renamed, so it is safe to apply on top of an existing
-- (pre-async-audit) `scores` table with data already in it.
--
-- Column notes:
--   - status: 'verified' (confirmed, ranking-eligible) or 'pending'
--     (accepted at POST time, not yet audited). DEFAULT 'verified' means
--     every pre-existing row — written under the previous, synchronous-
--     verification design where every accepted POST was already confirmed —
--     is backfilled as 'verified' with no separate UPDATE needed, and is
--     therefore never picked up by the audit job (spec item 13's confirmed
--     "既存行はそのまま verified としてバックフィルする(再監査対象にしな
--     い)"). New pending rows set status='pending' explicitly at INSERT time
--     (functions/api/scores.ts).
--   - ip_hash: HMAC-SHA-256(CF-Connecting-IP), keyed by a secret env var
--     (functions/_lib/ranking/ipHash.ts) — never the raw IP, never a
--     fixed/public salt. Nullable: pre-existing 'verified' rows predate this
--     column entirely and have no IP on file to hash retroactively; every
--     NEW pending row always has one (the POST handler fails closed via
--     ipHash.ts's requireIpHashKey() before reaching this INSERT if the
--     secret isn't configured).
--   - audit_attempts / next_attempt_at: the async-audit retry bookkeeping
--     for a pending row that hit an unexpected (non-typed) runtime error
--     during verification (spec item 3's "非型付きの予期しない例外は
--     audit_attempts インクリメント+next_attempt_at によるリトライ" — a
--     CONFIRMED invalid replay is deleted immediately and never touches
--     these columns at all). next_attempt_at is unixepoch()-scale SECONDS
--     (matching D1/SQLite's own unixepoch() function, not milliseconds like
--     created_at — deliberately: every comparison against next_attempt_at
--     happens in raw SQL against unixepoch(), never in JS against
--     Date.now(), so keeping the same unit avoids a conversion at every call
--     site).
ALTER TABLE scores ADD COLUMN status TEXT NOT NULL DEFAULT 'verified';
ALTER TABLE scores ADD COLUMN ip_hash TEXT;
ALTER TABLE scores ADD COLUMN audit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scores ADD COLUMN next_attempt_at INTEGER;

-- Serves BOTH the confirmed-TOP10 query (status='verified', used for
-- `entries` and the pre-gate's 10th-place threshold) and the display-pending
-- candidate query (status='pending', LIMIT 3, merged into `displayEntries`)
-- — same (season_id, ruleset_version, score DESC, rank_seq ASC) ordering
-- either way, just filtered by a different `status` value, so one composite
-- index with `status` leading covers both call sites (functions/_lib/ranking/
-- pendingGate.ts, functions/api/ranking.ts).
CREATE INDEX idx_scores_status_season_ruleset_rank
  ON scores(status, season_id, ruleset_version, score DESC, rank_seq ASC);

-- The pending-cap atomic INSERT's two COUNT(*) subqueries (functions/api/
-- scores.ts) and the 24h-expiry sweep (scripts/audit/) both filter on
-- (status='pending', created_at) — global count — or additionally ip_hash
-- for the per-IP count.
CREATE INDEX idx_scores_pending_created ON scores(status, created_at);
CREATE INDEX idx_scores_pending_ip_created ON scores(status, ip_hash, created_at);

-- The audit job's own fetch query (spec item 7's confirmed
-- `WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at
-- <= runStartedAt) ORDER BY rank_seq LIMIT 50`) — rank_seq is the ordering
-- (first-come-first-served through the queue), next_attempt_at is filtered
-- in the WHERE clause on top of this index's scan rather than as a second
-- indexed column, since it's an inequality-or-NULL condition that can't
-- itself narrow a B-tree seek the way an equality column can.
CREATE INDEX idx_scores_pending_rank_seq ON scores(status, rank_seq);

-- Single-row mutex for the async audit job (spec item 9's confirmed
-- owner_token + locked_until fencing design). `id` is always 1 — there is
-- exactly one row, acquired/renewed/released via conditional UPDATEs
-- (scripts/audit/lock.ts), never inserted again after this migration.
-- owner_token is TEXT (a random hex string minted per audit run, not an
-- integer) so a lock holder can be compared for exact identity without any
-- ambiguity about a default/unset value colliding with a real one.
-- Nullable (deliberately no NOT NULL): spec item 9's confirmed release step
-- sets it to NULL ("owner_token=NULL") — the initial row still gets an
-- explicit '' (spec item 13), not NULL, so acquireLock()'s very first
-- `WHERE locked_until < now` match is never confused by a NULL comparison,
-- but every subsequent release genuinely clears it.
CREATE TABLE audit_lock (
  id INTEGER PRIMARY KEY,
  owner_token TEXT,
  locked_until INTEGER NOT NULL
);

-- The initial row (spec item 13's confirmed requirement): without it, the
-- lock-acquire UPDATE (`WHERE id=1 AND locked_until < now`) always matches
-- zero rows on a freshly-migrated database, and the audit job could never
-- acquire the lock at all. owner_token='' / locked_until=0 is a row no
-- owner_token (always a freshly-minted non-empty token) can ever match as
-- "already held by me", and locked_until=0 is always < any real `now`, so
-- the very first acquire attempt succeeds immediately.
INSERT INTO audit_lock (id, owner_token, locked_until)
VALUES (1, '', 0)
ON CONFLICT(id) DO NOTHING;
