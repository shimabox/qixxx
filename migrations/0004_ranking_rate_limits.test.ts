import { afterEach, describe, expect, it } from 'vitest';
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

describe('migrations/0004_ranking_rate_limits.sql (real local D1)', () => {
  it('adds the rate-limit schema without changing existing scores', async () => {
    persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-migration-0004-test-d1-'));
    for (const migration of ['0001_create_scores.sql', '0002_ranking_free_async.sql', '0003_submitter_hash.sql']) {
      wrangler(persistDir, `--file=migrations/${migration}`);
    }
    wrangler(
      persistDir,
      '--command',
      `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at, submitter_hash)
       VALUES ('verified', 1, 1, 1, 500, 3, 'OLD', NULL, 42, X'0001', 100, 'hash-1', 1700000000000, 'verified', NULL, 0, NULL, NULL),
              ('pending', 1, 1, 1, 400, 2, 'NEW', '@new', 43, X'0203', 90, 'hash-2', 1700000000001, 'pending', 'ip-hash', 2, 1700000300, 'submitter-hash')`
    );

    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: path.join(REPO_ROOT, 'wrangler.toml'),
      persist: { path: path.join(persistDir, 'v3') },
    });
    try {
      const before = await proxy.env.DB.prepare('SELECT * FROM scores ORDER BY id').all();
      wrangler(persistDir, '--file=migrations/0004_ranking_rate_limits.sql');
      const after = await proxy.env.DB.prepare('SELECT * FROM scores ORDER BY id').all();
      expect(after.results).toEqual(before.results);

      const columns = await proxy.env.DB.prepare('PRAGMA table_info(ranking_rate_limits)').all<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>();
      expect(columns.results.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
        { name: 'ip_hash', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'window_index', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'request_count', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);
      const index = await proxy.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ranking_rate_limits_window'").first<{
        name: string;
      }>();
      expect(index?.name).toBe('idx_ranking_rate_limits_window');
      const indexedColumns = await proxy.env.DB.prepare("PRAGMA index_info('idx_ranking_rate_limits_window')").all<{ name: string }>();
      expect(indexedColumns.results.map((column) => column.name)).toEqual(['window_index']);

      await proxy.env.DB.prepare('INSERT INTO ranking_rate_limits VALUES (?1, ?2, ?3, ?4)').bind('valid-hash', 1, 1, 3600).run();
      await expect(proxy.env.DB.prepare('INSERT INTO ranking_rate_limits VALUES (?1, ?2, ?3, ?4)').bind('zero-hash', 1, 0, 3600).run()).rejects.toThrow(/CHECK constraint failed/i);
      await expect(proxy.env.DB.prepare('INSERT INTO ranking_rate_limits VALUES (?1, ?2, ?3, ?4)').bind('valid-hash', 2, 1, 7200).run()).rejects.toThrow(/UNIQUE constraint failed/i);
    } finally {
      await proxy.dispose();
    }
  }, 30_000);
});
