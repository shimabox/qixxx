// Real-D1 migration test for 0003 (docs/plans/2026-08-22-pending-self-
// replace task 1). Applies 0001 + 0002 alone — the schema as it stands
// BEFORE this feature, with a row already in it — then applies 0003 on top
// and confirms what the migration's own comments promise, rather than
// asserting on the .sql file's text.
//
// The property that matters most here is negative: a row written before this
// column existed must come out with submitter_hash NULL, because NULL is what
// makes it permanently un-replaceable by anybody (SQL equality against NULL
// is never true, so no submitter_hash a client can present will ever match
// it). A migration that back-filled a placeholder — an empty string, say —
// would hand every token-less legacy row to whichever browser happened to
// hash to that value.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

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

describe('migrations/0003_submitter_hash.sql (real local D1)', () => {
  it('adds a nullable submitter_hash that pre-existing rows come out of the migration with as NULL, and indexes the delete-candidate lookup', async () => {
    persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-migration-0003-test-d1-'));
    wrangler(persistDir, '--file=migrations/0001_create_scores.sql');
    wrangler(persistDir, '--file=migrations/0002_ranking_free_async.sql');

    // Two rows in the shape the pre-0003 handler wrote: one already verified
    // (the legacy era), one pending (this branch's async-audit era). Neither
    // has a submitter_hash column to fill in at this point.
    wrangler(
      persistDir,
      '--command',
      `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at)
       VALUES ('pre0003-verified', 1, 1, 1, 500, 3, 'OLD', NULL, 42, X'0001', 100, 'pre0003-hash-1', 1700000000000, 'verified', NULL, 0, NULL),
              ('pre0003-pending', 1, 1, 1, 400, 2, 'OLD2', NULL, 43, X'0001', 90, 'pre0003-hash-2', 1700000000001, 'pending', 'some-ip-hash', 0, NULL)`
    );

    wrangler(persistDir, '--file=migrations/0003_submitter_hash.sql');

    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: path.join(REPO_ROOT, 'wrangler.toml'),
      persist: { path: path.join(persistDir, 'v3') },
    });
    try {
      const { results } = await proxy.env.DB.prepare(`SELECT id, status, submitter_hash FROM scores ORDER BY id`).all<{
        id: string;
        status: string;
        submitter_hash: string | null;
      }>();
      expect(results).toEqual([
        { id: 'pre0003-pending', status: 'pending', submitter_hash: null },
        { id: 'pre0003-verified', status: 'verified', submitter_hash: null },
      ]);

      // NULL really is un-matchable: this is the SQL-level reason a legacy or
      // token-less row can never be chosen as somebody's delete candidate.
      const matched = await proxy.env.DB.prepare(`SELECT COUNT(*) AS c FROM scores WHERE submitter_hash = ?1`).bind('').first<{ c: number }>();
      expect(matched!.c).toBe(0);

      // The column accepts a hash on new writes (it is nullable, not
      // read-only) — the ordinary case for every row POST writes from now on.
      await proxy.env.DB.prepare(
        `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at, submitter_hash)
         VALUES ('post0003', 1, 1, 1, 600, 4, 'NEW', NULL, 44, X'0001', 110, 'post0003-hash', 1700000000002, 'pending', 'ip', 0, NULL, 'deadbeef')`
      ).run();
      const owned = await proxy.env.DB.prepare(`SELECT id FROM scores WHERE submitter_hash = ?1`).bind('deadbeef').all<{ id: string }>();
      expect(owned.results.map((r) => r.id)).toEqual(['post0003']);

      const index = await proxy.env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scores_pending_submitter'`).first<{ name: string }>();
      expect(index?.name).toBe('idx_scores_pending_submitter');
    } finally {
      await proxy.dispose();
    }
  }, 30_000);
});
