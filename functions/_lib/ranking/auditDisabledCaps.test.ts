// RANKING_AUDIT_MODE=disabled against a REAL local D1: what the audit-free
// mode's capped INSERT actually stores, and where its caps actually bite.
// The SQL text and bind order are pinned with a recording stub in
// scoresEndpoint.test.ts; this file checks the COUNT boundaries against
// genuine SQLite, which a stub cannot.
//
// The audit-free caps reuse the audited mode's numbers and window — at most
// 200 rows overall and 3 per IP hash among rows created in the last 72h — but
// count rows of EITHER status, because in this mode every stored row is a
// verified one and there is no pending queue to bound.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { onRequestPost } from '../../api/scores';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { computeIpHash } from './ipHash';
import { computeReplayHash } from './hash';
import { computeSubmitterHash } from './submitterToken';
import { PENDING_EXPIRY_MS } from './pendingGate';
import { encodeRle, type InputSample } from '../../../src/core/rle';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'audit-disabled-caps-test-hmac-key';
const IP = '203.0.113.9';
const MY_TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

function rleBytesFor(seed: number): Uint8Array {
  const samples: InputSample[] = [
    { dx: 1, dy: 0, drawHeld: false, slow: false },
    { dx: 0, dy: 1, drawHeld: true, slow: seed % 2 === 0 },
    { dx: seed % 3 === 0 ? -1 : 1, dy: 0, drawHeld: false, slow: false },
  ];
  return encodeRle(samples);
}

function rleBase64For(seed: number): string {
  let binary = '';
  for (const b of rleBytesFor(seed)) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function post(db: D1Database, mode: string | undefined, opts: { seed: number; score: number; ip?: string; token?: string }) {
  const body: Record<string, unknown> = {
    seed: opts.seed,
    rleBase64: rleBase64For(opts.seed),
    score: opts.score,
    stage: 2,
    name: 'PLAYER',
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
  };
  if (opts.token !== undefined) body.submitterToken = opts.token;
  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip ?? IP },
    body: JSON.stringify(body),
  });
  const env = { DB: db, RANKING_IP_HASH_KEY: IP_HASH_KEY, ...(mode === undefined ? {} : { RANKING_AUDIT_MODE: mode }) };
  type Ctx = Parameters<typeof onRequestPost>[0];
  const response = await onRequestPost({ request, env, params: {} } as unknown as Ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface StoredRow {
  id: string;
  status: string;
  score: number;
  stage: number;
  audit_attempts: number;
  next_attempt_at: number | null;
  submitter_hash: string | null;
  ip_hash: string | null;
  duration_ticks: number;
  created_at: number;
}

describe('RANKING_AUDIT_MODE=disabled caps (real local D1)', () => {
  let testDb: TestD1;
  let myIpHash: string;

  beforeAll(async () => {
    testDb = await createTestD1();
    myIpHash = await computeIpHash(IP, IP_HASH_KEY);
  }, 30_000);

  afterAll(async () => {
    await testDb.dispose();
  });

  beforeEach(async () => {
    await testDb.db.prepare(`DELETE FROM scores`).run();
    await testDb.db.prepare(`DELETE FROM ranking_rate_limits`).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function rowCount(): Promise<number> {
    const row = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores`).first<{ c: number }>();
    return row!.c;
  }

  async function storedRow(id: string): Promise<StoredRow | null> {
    return testDb.db
      .prepare(`SELECT id, status, score, stage, audit_attempts, next_attempt_at, submitter_hash, ip_hash, duration_ticks, created_at FROM scores WHERE id = ?1`)
      .bind(id)
      .first<StoredRow>();
  }

  /** A current-season row. Scores default low so seeded verified rows never raise the pre-gate threshold above the claims posted here. */
  function seed(overrides: Parameters<typeof seedScoreRow>[1]): Promise<string> {
    return seedScoreRow(testDb.db, {
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      replay_format_version: REPLAY_FORMAT_VERSION,
      created_at: Date.now(),
      score: 1,
      ...overrides,
    });
  }

  it('stores the submission as verified, with audit bookkeeping at rest and the owner hash kept, and answers status:verified', async () => {
    const { status, body } = await post(testDb.db, 'disabled', { seed: 5001, score: 4321, token: MY_TOKEN });
    expect(status).toBe(200);
    expect(body).toMatchObject({ accepted: true, status: 'verified', message: 'accepted', score: 4321, stage: 2, durationTicks: 3 });

    const row = await storedRow(body.id as string);
    expect(row).toMatchObject({ status: 'verified', score: 4321, stage: 2, audit_attempts: 0, next_attempt_at: null, ip_hash: myIpHash, duration_ticks: 3 });
    // Deliberately kept on a verified row in this mode (audited mode clears it
    // at verification): self-replacement needs it.
    expect(row!.submitter_hash).toBe(await computeSubmitterHash(MY_TOKEN));
  });

  it('stores a NULL submitter_hash for a token-less submission', async () => {
    const { body } = await post(testDb.db, 'disabled', { seed: 5011, score: 10 });
    expect((await storedRow(body.id as string))!.submitter_hash).toBeNull();
  });

  describe('self-replacement', () => {
    it('at exactly the per-IP cap, a better claim replaces this browser\'s weakest verified row', async () => {
      const myHash = await computeSubmitterHash(MY_TOKEN);
      const weakest = await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 100 });
      const kept = [await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 200 }), await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 300 })];

      const { status, body } = await post(testDb.db, 'disabled', { seed: 5012, score: 400, token: MY_TOKEN });
      expect(status).toBe(200);
      expect(body.status).toBe('verified');
      expect(await storedRow(weakest)).toBeNull();
      for (const id of kept) expect(await storedRow(id)).not.toBeNull();
      expect(await storedRow(body.id as string)).toMatchObject({ status: 'verified', score: 400, submitter_hash: myHash });
      expect(await rowCount()).toBe(3);
    });

    it('counts a leftover pending row of the same owner as a candidate too (no status predicate anywhere)', async () => {
      const myHash = await computeSubmitterHash(MY_TOKEN);
      const leftoverPending = await seed({ status: 'pending', ip_hash: myIpHash, submitter_hash: myHash, score: 50 });
      await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 200 });
      await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 300 });

      const { status } = await post(testDb.db, 'disabled', { seed: 5013, score: 400, token: MY_TOKEN });
      expect(status).toBe(200);
      expect(await storedRow(leftoverPending)).toBeNull();
      expect(await rowCount()).toBe(3);
    });

    // Reachable right after switching from the audited mode: the last 72h of
    // audited verified rows now count too, and can put an IP over its cap.
    // The case analysis only offers a candidate at EXACTLY the cap, so this is
    // a plain 429 that deletes nothing.
    it('over the per-IP cap: 429, and nothing is deleted even though weaker own rows exist', async () => {
      const myHash = await computeSubmitterHash(MY_TOKEN);
      const seeded = [
        await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 100 }),
        await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: myHash, score: 200 }),
        await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: null, score: 300 }),
        await seed({ status: 'pending', ip_hash: myIpHash, submitter_hash: myHash, score: 10 }),
      ];

      const { status, body } = await post(testDb.db, 'disabled', { seed: 5014, score: 999, token: MY_TOKEN });
      expect(status).toBe(429);
      expect(body).toEqual({ error: 'pending submission limit reached, try again later', accepted: false });
      for (const id of seeded) expect(await storedRow(id)).not.toBeNull();
      expect(await rowCount()).toBe(4);
    });

    it('at the cap with only rows it does not own (e.g. audited rows whose owner hash was cleared): 429', async () => {
      for (let i = 0; i < 3; i++) await seed({ status: 'verified', ip_hash: myIpHash, submitter_hash: null, score: 10 + i });
      const { status } = await post(testDb.db, 'disabled', { seed: 5015, score: 999, token: MY_TOKEN });
      expect(status).toBe(429);
      expect(await rowCount()).toBe(3);
    });
  });

  it.each([
    ['all verified', ['verified', 'verified', 'verified'] as const],
    ['verified and pending mixed', ['verified', 'pending', 'verified'] as const],
    ['all pending', ['pending', 'pending', 'pending'] as const],
  ])('refuses a 4th row from an IP that already has 3 fresh rows (%s)', async (_label, statuses) => {
    for (const status of statuses) await seed({ status, ip_hash: myIpHash });

    const { status, body } = await post(testDb.db, 'disabled', { seed: 5002, score: 900 });
    expect(status).toBe(429);
    expect(body).toEqual({ error: 'pending submission limit reached, try again later', accepted: false });
    expect(await rowCount()).toBe(3);
  });

  it('accepts the 3rd row from an IP (the cap is "fewer than 3 already")', async () => {
    await seed({ status: 'verified', ip_hash: myIpHash });
    await seed({ status: 'pending', ip_hash: myIpHash });
    const { status } = await post(testDb.db, 'disabled', { seed: 5003, score: 900 });
    expect(status).toBe(200);
    expect(await rowCount()).toBe(3);
  });

  it('refuses any row once 200 fresh rows exist overall, whatever their status and IP', async () => {
    for (let i = 0; i < 200; i++) await seed({ status: i % 2 === 0 ? 'verified' : 'pending', ip_hash: `filler-${i}` });

    const { status } = await post(testDb.db, 'disabled', { seed: 5004, score: 900 });
    expect(status).toBe(429);
    expect(await rowCount()).toBe(200);
  });

  it('accepts at 199 fresh rows overall', async () => {
    for (let i = 0; i < 199; i++) await seed({ status: 'verified', ip_hash: `filler-${i}` });
    const { status } = await post(testDb.db, 'disabled', { seed: 5005, score: 900 });
    expect(status).toBe(200);
    expect(await rowCount()).toBe(200);
  });

  // Fresh = `created_at > cutoff`, expired = `created_at <= cutoff`, with
  // cutoff = now - 72h — the one boundary pendingFreshnessCutoff() defines.
  it('does not count rows at or before the 72h cutoff, and does count a row 1ms inside it', async () => {
    const now = 1_900_000_000_000;
    const cutoff = now - PENDING_EXPIRY_MS;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await seed({ status: 'verified', ip_hash: myIpHash, created_at: cutoff });
    await seed({ status: 'verified', ip_hash: myIpHash, created_at: cutoff - 1 });
    await seed({ status: 'pending', ip_hash: myIpHash, created_at: cutoff });
    await seed({ status: 'verified', ip_hash: myIpHash, created_at: cutoff + 1 });
    await seed({ status: 'verified', ip_hash: myIpHash, created_at: now });

    // 2 fresh rows on this IP (cutoff+1 and now) — room for one more.
    const third = await post(testDb.db, 'disabled', { seed: 5006, score: 900 });
    expect(third.status).toBe(200);
    // Now 3 fresh rows — the expired ones still don't count, so this is the cap.
    const fourth = await post(testDb.db, 'disabled', { seed: 5007, score: 900 });
    expect(fourth.status).toBe(429);
  });

  it('answers 409, not 429, at the cap to a seed or replay already on file', async () => {
    const onFileSeed = 5008;
    const onFileHash = await computeReplayHash({ seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, seed: onFileSeed, rle: rleBytesFor(onFileSeed) });
    await seed({ status: 'verified', ip_hash: myIpHash, seed: onFileSeed, replay_hash: onFileHash });
    await seed({ status: 'verified', ip_hash: myIpHash });
    await seed({ status: 'pending', ip_hash: myIpHash });

    const sameReplay = await post(testDb.db, 'disabled', { seed: onFileSeed, score: 900 });
    expect(sameReplay.status).toBe(409);
    expect(sameReplay.body).toEqual({ error: 'duplicate replay', accepted: false });

    // A different stream under an rng-equivalent seed (migrations/0005).
    await testDb.db.prepare(`DELETE FROM scores WHERE seed = ?1`).bind(onFileSeed).run();
    await seed({ status: 'verified', ip_hash: myIpHash, seed: 1485211075 });
    const colliding = await post(testDb.db, 'disabled', { seed: 2522981067, score: 900 });
    expect(colliding.status).toBe(409);
    expect(await rowCount()).toBe(3);
  });

  it('audited mode, by contrast, still counts only fresh PENDING rows: 3 verified rows on the IP leave room', async () => {
    for (let i = 0; i < 3; i++) await seed({ status: 'verified', ip_hash: myIpHash });
    const { status, body } = await post(testDb.db, undefined, { seed: 5009, score: 900 });
    expect(status).toBe(200);
    expect(body.status).toBe('pending');
    expect((await storedRow(body.id as string))!.status).toBe('pending');
  });

  it('audited mode refuses at 3 fresh pending rows on the IP, as before', async () => {
    for (let i = 0; i < 3; i++) await seed({ status: 'pending', ip_hash: myIpHash });
    const { status } = await post(testDb.db, 'enabled', { seed: 5010, score: 900 });
    expect(status).toBe(429);
  });
});
