// Real-D1 migration test for 0005. Applies 0001–0004 with rows already in
// place, then 0005 on top, and confirms the three properties the migration
// exists for: every pre-existing row is backfilled with exactly the value
// computeRngKey() produces in JS; a copied replay re-submitted under the
// same seed OR an rng-equivalent one is refused at INSERT time; and a
// database whose existing rows already collide is left completely untouched
// (the batch rolls back, column included).
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { computeRngKey } from '../functions/_lib/ranking/rngKey';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let persistDir: string | null = null;

afterEach(() => {
  if (persistDir) fs.rmSync(persistDir, { recursive: true, force: true });
  persistDir = null;
});

function wrangler(dir: string, ...extra: string[]): void {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'execute', 'qixxx-scores', '--local', '--persist-to', dir, ...extra], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}

const PRIOR_MIGRATIONS = ['0001_create_scores.sql', '0002_ranking_free_async.sql', '0003_submitter_hash.sql', '0004_ranking_rate_limits.sql'];

/** Column list as it stands after 0004 — what pre-0005 rows were written with. */
const INSERT_PRE_0005 = `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at, submitter_hash)`;
/** Column list POST /api/scores writes after 0005. */
const INSERT_POST_0005 = `${INSERT_PRE_0005.slice(0, -1)}, rng_key)`;

function preRow(id: string, seed: number, replayHash: string, status: 'verified' | 'pending'): string {
  return `('${id}', 1, 1, 1, 500, 3, 'OLD', NULL, ${seed}, X'0001', 100, '${replayHash}', 1700000000000, '${status}', NULL, 0, NULL, NULL)`;
}

function postRow(id: string, seasonId: number, seed: number, replayHash: string): string {
  return `('${id}', ${seasonId}, 1, 1, 501, 3, 'COPY', NULL, ${seed}, X'0002', 101, '${replayHash}', 1700000000002, 'pending', 'ip', 0, NULL, NULL, ${computeRngKey(seed)})`;
}

// The two halves of a known deriveStageSeed() collision, plus the edges of
// the uint32 seed range and a few ordinary values — the backfill has to
// agree with JS on every one of them.
const COLLIDING_A = 1485211075;
const COLLIDING_B = 2522981067;
const SEEDS = [0, 1, 9, 10, 1264, 65535, 4294967295, COLLIDING_A];

function setupWithPriorMigrations(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-migration-0005-test-d1-'));
  for (const file of PRIOR_MIGRATIONS) wrangler(dir, `--file=migrations/${file}`);
  return dir;
}

describe('migrations/0005_scores_rng_key.sql (real local D1)', () => {
  it('backfills every existing row with the JS computeRngKey() value, then refuses copies under the same and under an rng-equivalent seed', async () => {
    persistDir = setupWithPriorMigrations();
    wrangler(persistDir, '--command', `${INSERT_PRE_0005} VALUES ${SEEDS.map((seed, i) => preRow(`pre-${i}`, seed, `pre-hash-${i}`, i % 2 === 0 ? 'verified' : 'pending')).join(', ')}`);

    wrangler(persistDir, '--file=migrations/0005_scores_rng_key.sql');

    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: path.join(REPO_ROOT, 'wrangler.toml'),
      persist: { path: path.join(persistDir, 'v3') },
    });
    try {
      const { results } = await proxy.env.DB.prepare(`SELECT seed, rng_key FROM scores ORDER BY rank_seq`).all<{ seed: number; rng_key: number | null }>();
      expect(results.map((r) => r.seed)).toEqual(SEEDS);
      for (const row of results) {
        expect(row.rng_key).toBe(computeRngKey(row.seed));
      }
      const nulls = await proxy.env.DB.prepare(`SELECT COUNT(*) AS c FROM scores WHERE rng_key IS NULL`).first<{ c: number }>();
      expect(nulls!.c).toBe(0);

      const index = await proxy.env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scores_rng_key'`).first<{ name: string }>();
      expect(index?.name).toBe('idx_scores_rng_key');

      // The copied-replay shape under the SAME seed as a stored row, with a
      // replay_hash nobody has seen, across season and status boundaries.
      await expect(proxy.env.DB.prepare(`${INSERT_POST_0005} VALUES ${postRow('copy-same-seed-verified', 2, 0, 'fresh-hash-1')}`).run()).rejects.toThrow(
        /UNIQUE constraint failed: scores\.rng_key/
      );
      await expect(proxy.env.DB.prepare(`${INSERT_POST_0005} VALUES ${postRow('copy-same-seed-pending', 1, 1, 'fresh-hash-2')}`).run()).rejects.toThrow(
        /UNIQUE constraint failed: scores\.rng_key/
      );

      // The copy a seed index could not see: a DIFFERENT numeric seed with
      // the same rng streams.
      expect(computeRngKey(COLLIDING_B)).toBe(computeRngKey(COLLIDING_A));
      await expect(proxy.env.DB.prepare(`${INSERT_POST_0005} VALUES ${postRow('copy-colliding', 2, COLLIDING_B, 'fresh-hash-3')}`).run()).rejects.toThrow(
        /UNIQUE constraint failed: scores\.rng_key/
      );

      // An unrelated seed is unaffected.
      await proxy.env.DB.prepare(`${INSERT_POST_0005} VALUES ${postRow('post0005', 1, 777, 'post0005-hash')}`).run();
      const count = await proxy.env.DB.prepare(`SELECT COUNT(*) AS c FROM scores`).first<{ c: number }>();
      expect(count!.c).toBe(SEEDS.length + 1);
    } finally {
      await proxy.dispose();
    }
  }, 30_000);

  it('refuses to apply when existing rows already collide, leaving the schema exactly as it was', async () => {
    persistDir = setupWithPriorMigrations();
    wrangler(persistDir, '--command', `${INSERT_PRE_0005} VALUES ${preRow('dup-a', COLLIDING_A, 'dup-hash-a', 'verified')}, ${preRow('dup-b', COLLIDING_B, 'dup-hash-b', 'pending')}`);

    expect(() => wrangler(persistDir!, '--file=migrations/0005_scores_rng_key.sql')).toThrow(/UNIQUE constraint failed: scores\.rng_key/);

    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: path.join(REPO_ROOT, 'wrangler.toml'),
      persist: { path: path.join(persistDir, 'v3') },
    });
    try {
      // The whole batch rolled back: no column, no index, both rows intact.
      const column = await proxy.env.DB.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('scores') WHERE name = 'rng_key'`).first<{ c: number }>();
      expect(column!.c).toBe(0);
      const index = await proxy.env.DB.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = 'idx_scores_rng_key'`).first<{ c: number }>();
      expect(index!.c).toBe(0);
      const rows = await proxy.env.DB.prepare(`SELECT id FROM scores ORDER BY id`).all<{ id: string }>();
      expect(rows.results.map((r) => r.id)).toEqual(['dup-a', 'dup-b']);
    } finally {
      await proxy.dispose();
    }
  }, 30_000);
});
