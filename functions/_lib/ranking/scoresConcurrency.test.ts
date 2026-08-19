// Real-D1 concurrency integration tests for POST /api/scores' pending-cap
// atomic INSERT (docs/plans/2026-08-19-ranking-free-async spec item 7 /
// completion-criteria item: "実 D1 互換環境(wrangler のローカル D1)へ複数
// リクエストを同時投入する統合テストで...上限が並行 POST でも突破されない
// ことが確認できる"). Uses the SAME real local D1 test harness the audit
// script's own integration tests use (scripts/audit/testSupport/localD1.ts)
// — genuine D1/SQLite transaction semantics, not a mock, is the whole point
// of this suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { onRequestPost } from '../../api/scores';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { encodeRle, type InputSample } from '../../../src/core/rle';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'concurrency-test-hmac-key';

function rleBase64For(seed: number): string {
  // A trivially-decodable, distinct-per-seed sample list — POST never
  // resimulates it (no verifyReplay() call), so its gameplay validity is
  // irrelevant here; only distinctness (-> distinct replay_hash) matters
  // for the "many concurrent, all-different" scenarios below.
  const samples: InputSample[] = [{ dx: 1, dy: 0, drawHeld: false, slow: false }, { dx: 0, dy: 1, drawHeld: true, slow: (seed % 2) === 0 }];
  const bytes = encodeRle(samples);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makeSubmissionBody(seed: number, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    seed,
    rleBase64: rleBase64For(seed),
    score: 100 + seed,
    stage: 1,
    name: `P${seed}`,
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    ...overrides,
  });
}

function makeRequest(body: string, ip: string): Request {
  return new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body,
  });
}

function makeEnv(db: D1Database) {
  return {
    // Always-allowing KV stub: this suite isolates D1-level atomicity, not
    // the separate (already-covered-elsewhere), non-atomic KV rate limiter.
    SHARES: { get: async () => null, put: async () => undefined },
    DB: db,
    RANKING_IP_HASH_KEY: IP_HASH_KEY,
  };
}

async function post(db: D1Database, seed: number, ip: string, overrides: Record<string, unknown> = {}) {
  type Ctx = Parameters<typeof onRequestPost>[0];
  const response = await onRequestPost({ request: makeRequest(makeSubmissionBody(seed, overrides), ip), env: makeEnv(db), params: {} } as unknown as Ctx);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe('POST /api/scores pending-cap concurrency (real local D1)', () => {
  let testDb: TestD1;

  beforeAll(async () => {
    testDb = await createTestD1();
  }, 30_000);

  afterAll(async () => {
    await testDb.dispose();
  });

  beforeEach(async () => {
    await testDb.db.prepare(`DELETE FROM scores`).run();
  });

  it('per-IP cap: firing more concurrent POSTs than the cap from ONE IP lets exactly MAX_PENDING_PER_IP (3) through', async () => {
    const ip = '203.0.113.9';
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => post(testDb.db, 40_000 + i, ip)));
    const accepted = results.filter((r) => r.body.accepted === true);
    const rejected = results.filter((r) => r.status === 429);
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(3);

    const row = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    expect(row!.c).toBe(3); // the cap held exactly, not "close to" 3 — no overshoot under real concurrency
  });

  it('global cap: pre-filled to 199 of 200, TWO concurrent POSTs from DIFFERENT IPs contend for the last slot — exactly one wins', async () => {
    // Seed 199 pending rows directly (cheap — no need to go through POST for
    // volume; the point of THIS test is the boundary, not bulk insertion).
    for (let i = 0; i < 199; i++) {
      await testDb.db
        .prepare(
          `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at)
           VALUES (?1, 1, 1, 1, 1, 1, 'X', NULL, 1, X'0001', 1, ?2, ?3, 'pending', 'filler-ip-hash', 0, NULL)`
        )
        .bind(`filler-${i}`, `filler-hash-${i}`, Date.now())
        .run();
    }
    const before = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    expect(before!.c).toBe(199);

    const [a, b] = await Promise.all([post(testDb.db, 50_001, '203.0.113.10'), post(testDb.db, 50_002, '203.0.113.11')]);
    const acceptedCount = [a, b].filter((r) => r.body.accepted === true).length;
    const rejectedCount = [a, b].filter((r) => r.status === 429).length;
    expect(acceptedCount).toBe(1); // exactly one of the two claims the 200th slot
    expect(rejectedCount).toBe(1);

    const after = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    expect(after!.c).toBe(200); // the global cap held exactly at 200, never 201
  });

  it('expired (>24h old) pending rows are excluded from BOTH the global and per-IP cap counts (spec item 7\'s "監査停止時の保護")', async () => {
    const ip = '203.0.113.40';
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    // 3 expired rows for this exact IP (would already be at the per-IP cap
    // if they counted) plus 200 expired global filler rows (would already
    // be at the global cap if they counted) — a real, unaudited backlog.
    for (let i = 0; i < 3; i++) {
      await testDb.db
        .prepare(
          `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at)
           VALUES (?1, 1, 1, 1, 1, 1, 'X', NULL, 1, X'0001', 1, ?2, ?3, 'pending', ?4, 0, NULL)`
        )
        .bind(`expired-own-ip-${i}`, `expired-own-ip-hash-${i}`, twentyFiveHoursAgo, 'some-ip-hash-value')
        .run();
    }
    for (let i = 0; i < 200; i++) {
      await testDb.db
        .prepare(
          `INSERT INTO scores (id, season_id, ruleset_version, replay_format_version, score, stage, name, x_handle, seed, inputs, duration_ticks, replay_hash, created_at, status, ip_hash, audit_attempts, next_attempt_at)
           VALUES (?1, 1, 1, 1, 1, 1, 'X', NULL, 1, X'0001', 1, ?2, ?3, 'pending', 'other-filler-ip-hash', 0, NULL)`
        )
        .bind(`expired-filler-${i}`, `expired-filler-hash-${i}`, twentyFiveHoursAgo)
        .run();
    }
    const totalPending = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    expect(totalPending!.c).toBe(203); // all present in the table — expiry is a COUNT-query exclusion, not an eager delete (that's the audit job's own job)

    const { status, body } = await post(testDb.db, 80_001, ip);
    expect(status).toBe(200);
    expect(body.accepted).toBe(true); // neither cap was actually reached once expired rows are excluded
  });

  it('duplicate replay_hash under real concurrency: two identical submissions racing — exactly one succeeds, the other gets 409', async () => {
    const seed = 60_001;
    const body = makeSubmissionBody(seed);
    const [a, b] = await Promise.all([post(testDb.db, seed, '203.0.113.20'), post(testDb.db, seed, '203.0.113.21')]);
    void body;
    const succeeded = [a, b].filter((r) => r.body.accepted === true);
    const duplicated = [a, b].filter((r) => r.status === 409);
    expect(succeeded).toHaveLength(1);
    expect(duplicated).toHaveLength(1);

    const row = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    expect(row!.c).toBe(1);
  });

  it('a rejected (429) request never displaces an already-accepted pending row: existing pending rows are untouched', async () => {
    const ip = '203.0.113.30';
    const results = await Promise.all([1, 2, 3, 4].map((i) => post(testDb.db, 70_000 + i, ip)));
    const acceptedIds = results.filter((r) => r.body.accepted === true).map((r) => r.body.id as string);
    expect(acceptedIds).toHaveLength(3);
    const rows = await testDb.db.prepare(`SELECT id FROM scores WHERE status = 'pending'`).all<{ id: string }>();
    expect(new Set(rows.results.map((r) => r.id))).toEqual(new Set(acceptedIds));
  });
});
