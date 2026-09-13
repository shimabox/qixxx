// Real-D1 migration test for 0005. Applies 0001–0004 with rows already in
// place, then 0005 on top, and confirms the property the migration exists
// for: a second row under an already-stored seed is refused at INSERT time
// with a UNIQUE error, whatever its replay_hash says.
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

const INSERT = `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at, submitter_hash)`;

describe('migrations/0005_scores_seed_unique.sql (real local D1)', () => {
  it('keeps pre-existing rows, then refuses a second row under a stored seed even with a different replay_hash', async () => {
    persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-migration-0005-test-d1-'));
    for (const file of ['0001_create_scores.sql', '0002_ranking_free_async.sql', '0003_submitter_hash.sql', '0004_ranking_rate_limits.sql']) {
      wrangler(persistDir, `--file=migrations/${file}`);
    }
    wrangler(
      persistDir,
      '--command',
      `${INSERT} VALUES ('pre0005-verified', 1, 1, 1, 500, 3, 'OLD', NULL, 42, X'0001', 100, 'pre0005-hash-1', 1700000000000, 'verified', NULL, 0, NULL, NULL),
                  ('pre0005-pending', 1, 1, 1, 400, 2, 'OLD2', NULL, 43, X'0001', 90, 'pre0005-hash-2', 1700000000001, 'pending', 'some-ip-hash', 0, NULL, NULL)`
    );

    wrangler(persistDir, '--file=migrations/0005_scores_seed_unique.sql');

    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: path.join(REPO_ROOT, 'wrangler.toml'),
      persist: { path: path.join(persistDir, 'v3') },
    });
    try {
      const { results } = await proxy.env.DB.prepare(`SELECT id, seed FROM scores ORDER BY id`).all<{ id: string; seed: number }>();
      expect(results).toEqual([
        { id: 'pre0005-pending', seed: 43 },
        { id: 'pre0005-verified', seed: 42 },
      ]);

      const index = await proxy.env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scores_seed'`).first<{ name: string }>();
      expect(index?.name).toBe('idx_scores_seed');

      // The copied-replay shape: same seed as a stored row, a replay_hash
      // nobody has seen (one input sample changed), across season and
      // status boundaries alike.
      await expect(
        proxy.env.DB.prepare(
          `${INSERT} VALUES ('copy-of-verified', 2, 1, 1, 501, 3, 'COPY', NULL, 42, X'0002', 101, 'fresh-hash-1', 1700000000002, 'pending', 'ip', 0, NULL, NULL)`
        ).run()
      ).rejects.toThrow(/UNIQUE constraint failed: scores\.seed/);
      await expect(
        proxy.env.DB.prepare(
          `${INSERT} VALUES ('copy-of-pending', 1, 1, 1, 401, 2, 'COPY', NULL, 43, X'0002', 91, 'fresh-hash-2', 1700000000003, 'pending', 'ip', 0, NULL, NULL)`
        ).run()
      ).rejects.toThrow(/UNIQUE constraint failed: scores\.seed/);

      // An unrelated seed is unaffected.
      await proxy.env.DB.prepare(
        `${INSERT} VALUES ('post0005', 1, 1, 1, 600, 4, 'NEW', NULL, 44, X'0001', 110, 'post0005-hash', 1700000000004, 'pending', 'ip', 0, NULL, NULL)`
      ).run();
      const count = await proxy.env.DB.prepare(`SELECT COUNT(*) AS c FROM scores`).first<{ c: number }>();
      expect(count!.c).toBe(3);
    } finally {
      await proxy.dispose();
    }
  }, 30_000);
});
