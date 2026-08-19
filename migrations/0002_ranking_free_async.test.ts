// Real-D1 migration test (docs/plans/2026-08-19-ranking-free-async spec
// item 13 / completion criteria): applies 0001 alone (simulating the
// pre-async-audit, synchronous-verification-era schema with a row already
// in it), THEN applies 0002 on top, and confirms the backfill/initial-row
// behavior the migration's own comments promise — rather than merely
// asserting on the .sql file's text.
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

function execSql(dir: string, fileRelPath: string): void {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'execute', 'qixxx-scores', '--local', '--persist-to', dir, `--file=${fileRelPath}`], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}

describe('migrations/0002_ranking_free_async.sql (real local D1)', () => {
  it('backfills a pre-existing (0001-only) row as status=verified, and provisions the audit_lock initial row so the first acquire succeeds', async () => {
    persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-migration-test-d1-'));
    execSql(persistDir, 'migrations/0001_create_scores.sql');

    // A "legacy" row — exactly the shape the pre-async-audit, synchronous-
    // verification version of POST /api/scores would have written (no
    // status/ip_hash/audit_attempts/next_attempt_at columns exist yet at
    // this point).
    execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'qixxx-scores',
        '--local',
        '--persist-to',
        persistDir,
        '--command',
        `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at) VALUES ('legacy-1', 1, 1, 1, 500, 3, 'LEGACY', NULL, 42, X'0001', 100, 'legacy-hash-1', 1700000000000)`,
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );

    execSql(persistDir, 'migrations/0002_ranking_free_async.sql');

    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: path.join(REPO_ROOT, 'wrangler.toml'),
      persist: { path: path.join(persistDir, 'v3') },
    });
    try {
      const legacyRow = await proxy.env.DB.prepare(`SELECT status, ip_hash, audit_attempts, next_attempt_at FROM scores WHERE id = 'legacy-1'`).first<{
        status: string;
        ip_hash: string | null;
        audit_attempts: number;
        next_attempt_at: number | null;
      }>();
      expect(legacyRow).toEqual({ status: 'verified', ip_hash: null, audit_attempts: 0, next_attempt_at: null });

      // The initial audit_lock row (spec item 13) must exist, and the first
      // acquire attempt against it must succeed immediately.
      const lockRow = await proxy.env.DB.prepare(`SELECT owner_token, locked_until FROM audit_lock WHERE id = 1`).first<{
        owner_token: string;
        locked_until: number;
      }>();
      expect(lockRow).toEqual({ owner_token: '', locked_until: 0 });

      const acquireResult = await proxy.env.DB.prepare(
        `UPDATE audit_lock SET owner_token = 'first-acquire-test', locked_until = unixepoch() + 600 WHERE id = 1 AND locked_until < unixepoch()`
      ).run();
      expect(acquireResult.meta.changes).toBe(1);
    } finally {
      await proxy.dispose();
    }
  }, 30_000);
});
