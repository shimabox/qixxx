-- One ranking row per EFFECTIVE seed. Applied the same way as the earlier
-- migrations: via `wrangler d1 migrations apply qixxx-scores` — locally
-- against wrangler's local D1 emulation during development, against the real
-- D1 database only after the pre-check in docs/ranking-audit-runbook.md §2.2.
-- Additive-only: no column or index is dropped or renamed.
--
-- Why a UNIQUE index on an "effective seed" rather than on `seed`:
-- - A normal run's seed is 32 bits of crypto.getRandomValues() output drawn
--   fresh for every run (src/main.ts's generateNormalRunSeed()), so two
--   honest runs share a seed with probability 2^-32 per pair. Seeded
--   (`?seed=`) runs are never submitted at all.
-- - A replay served by GET /api/ranking/:id/replay carries its seed. The
--   existing `replay_hash` index only refuses the byte-identical input
--   stream, so one changed input sample near the end of a copied replay
--   yields a fresh hash — a second, "new" row reproducing somebody else's
--   run. Refusing a second row per seed closes that path at INSERT time.
-- - But the numeric seed is not the run's randomness. src/core/rng.ts's
--   deriveStageSeed(seed, stage) = FNV-1a("<seed>:<stage>") is, and FNV-1a's
--   per-byte step is a bijection on the 32-bit state, so two seeds whose
--   state agrees after "<seed>:" produce identical rng streams on every
--   stage (e.g. 1485211075 and 2522981067) — the same boards, the same
--   enemies, one replay valid under both, with a different seed AND a
--   different replay_hash. `rng_key` = deriveStageSeed(seed, 1) names that
--   equivalence class (functions/_lib/ranking/rngKey.ts); equal seeds have
--   equal rng_keys, so a UNIQUE index on it covers the plain same-seed copy
--   as well as the colliding-seed one.
-- - Not scoped to season_id: an old season's replay is still a copy, and a
--   seed is never legitimately reused across seasons either.
--
-- Three statements, one batch, all-or-nothing:
-- 1. Add the column (nullable — SQLite cannot add a NOT NULL column without
--    a default, and the only correct default is computed per row below).
-- 2. Backfill every existing row with the same FNV-1a the code computes, in
--    SQL: a recursive CTE walks the string "<seed>:1" one character at a
--    time. SQLite has no XOR operator, so `a ^ b` is written as
--    `(a | b) - (a & b)`; the multiply stays below 2^56 (state < 2^32, prime
--    < 2^25) so 64-bit integer arithmetic never overflows, and `& 0xFFFFFFFF`
--    wraps it to 32 bits exactly like JS's Math.imul(...) >>> 0.
--    migrations/0005_scores_rng_key.test.ts pins this SQL to the JS.
-- 3. Create the UNIQUE index. If two EXISTING rows already share an rng_key
--    this statement fails and the whole batch rolls back (column included),
--    leaving the database untouched — run the pre-check in the runbook
--    first and resolve the duplicates by hand.
--
-- POST /api/scores always supplies rng_key for new rows; a violation surfaces
-- as the same SQLite UNIQUE error it already maps to 409 "duplicate replay"
-- (functions/api/scores.ts's isUniqueConstraintViolation()).
ALTER TABLE scores ADD COLUMN rng_key INTEGER;

WITH RECURSIVE fnv(rank_seq, s, i, h) AS (
  SELECT rank_seq, CAST(seed AS TEXT) || ':1', 1, 2166136261
    FROM scores
   WHERE rng_key IS NULL
  UNION ALL
  SELECT rank_seq, s, i + 1,
         (((h | unicode(substr(s, i, 1))) - (h & unicode(substr(s, i, 1)))) * 16777619) & 4294967295
    FROM fnv
   WHERE i <= length(s)
)
UPDATE scores
   SET rng_key = (SELECT h FROM fnv WHERE fnv.rank_seq = scores.rank_seq AND fnv.i = length(fnv.s) + 1)
 WHERE rng_key IS NULL;

CREATE UNIQUE INDEX idx_scores_rng_key ON scores(rng_key);
