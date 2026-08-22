// Test-only helper: spins up a FRESH, fully-migrated, isolated local D1
// database for integration tests. Lock
// fencing, pending-cap concurrency, retry/expiry behavior, and the audit
// script's own D1 adapter are all exercised against REAL D1/SQLite
// semantics here, not a hand-rolled mock.
//
// Each call gets its own `--persist-to` directory (a fresh `mkdtemp`),
// migrated from scratch and torn down afterward — NEVER the shared
// `.wrangler/state/` directory `wrangler pages dev` / a developer's own
// manual `wrangler d1 migrations apply --local` use, so running this test
// suite can never corrupt or race against a developer's local dev data.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface TestD1 {
  db: D1Database;
  /** The directory the D1 files under this database live in — for debugging a failed test only, never asserted on. */
  persistDir: string;
  dispose: () => Promise<void>;
}

/**
 * Creates and migrates a throwaway local D1 database. Slowish (spawns
 * `wrangler d1 migrations apply`, ~1-2s) — call once per test FILE (a
 * `beforeAll`), not per test case, and share it across that file's tests
 * (each test should reset/scope its own rows rather than needing a fresh
 * database).
 */
export async function createTestD1(): Promise<TestD1> {
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-audit-test-d1-'));
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'migrations', 'apply', 'qixxx-scores', '--local', '--persist-to', persistDir], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    input: 'y\n',
  });

  // `wrangler d1 migrations apply --persist-to <dir>` writes its SQLite
  // files under `<dir>/v3/d1/...`, while getPlatformProxy()'s own
  // `persist: {path}` reads from `<path>/d1/...` directly (no `v3`
  // component) — confirmed by inspecting both tools' actual on-disk output
  // in this wrangler version (3.114.17); nothing in either CLI's --help or
  // the GetPlatformProxyOptions type documents this offset. `persistDir/v3`
  // is therefore the one path both commands agree describes the same
  // database.
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(REPO_ROOT, 'wrangler.toml'),
    persist: { path: path.join(persistDir, 'v3') },
  });

  return {
    db: proxy.env.DB,
    persistDir,
    dispose: async () => {
      await proxy.dispose();
      fs.rmSync(persistDir, { recursive: true, force: true });
    },
  };
}

let idCounter = 0;
let hashCounter = 0;

/**
 * Inserts one `scores` row directly (bypassing POST /api/scores entirely) —
 * for tests that need full, arbitrary control over every column (status,
 * audit_attempts, next_attempt_at, created_at, ip_hash, a deliberately
 * malformed `inputs` BLOB, etc.), which the real POST handler's own
 * validation would refuse to produce. `id`/`replay_hash` default to
 * per-process-unique values so many rows can be seeded in one test without
 * colliding on either UNIQUE index.
 */
export async function seedScoreRow(
  db: D1Database,
  overrides: Partial<{
    id: string;
    season_id: number;
    ruleset_version: number;
    replay_format_version: number;
    score: number;
    stage: number;
    name: string;
    x_handle: string | null;
    seed: number;
    inputs: Uint8Array;
    duration_ticks: number;
    replay_hash: string;
    created_at: number;
    status: 'verified' | 'pending';
    ip_hash: string | null;
    audit_attempts: number;
    next_attempt_at: number | null;
    submitter_hash: string | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `test-id-${++idCounter}`;
  const row = {
    id,
    season_id: 1,
    ruleset_version: 1,
    replay_format_version: 1,
    score: 100,
    stage: 1,
    name: 'TESTER',
    x_handle: null as string | null,
    seed: 1,
    inputs: new Uint8Array([0, 1]),
    duration_ticks: 1,
    replay_hash: `test-hash-${++hashCounter}`,
    created_at: Date.now(),
    status: 'pending' as 'verified' | 'pending',
    ip_hash: 'test-ip-hash',
    audit_attempts: 0,
    next_attempt_at: null as number | null,
    submitter_hash: null as string | null,
    ...overrides,
  };
  await db
    .prepare(
      `INSERT INTO scores
         (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at, submitter_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`
    )
    .bind(
      row.id,
      row.season_id,
      row.ruleset_version,
      row.replay_format_version,
      row.score,
      row.stage,
      row.name,
      row.x_handle,
      row.seed,
      row.inputs,
      row.duration_ticks,
      row.replay_hash,
      row.created_at,
      row.status,
      row.ip_hash,
      row.audit_attempts,
      row.next_attempt_at,
      row.submitter_hash
    )
    .run();
  return id;
}
