// End-to-end check of migrations/0005 through the real POST handler on a
// real local D1: a copied replay — same seed as a stored row, or a
// different seed with the same rng streams, inputs altered so the replay_hash
// is new — is refused as a duplicate, while a run under a fresh seed is
// accepted as usual.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { onRequestPost as postScore } from '../../api/scores';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { computeReplayHash } from './hash';
import { computeRngKey } from './rngKey';
import { encodeRle, type InputSample } from '../../../src/core/rle';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'seed-uniqueness-test-hmac-key';

function rleFor(variant: number): Uint8Array {
  const samples: InputSample[] = [
    { dx: 1, dy: 0, drawHeld: false, slow: false },
    { dx: 0, dy: 1, drawHeld: true, slow: variant % 2 === 0 },
    { dx: -1, dy: 0, drawHeld: true, slow: false },
  ];
  return encodeRle(samples);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function post(db: D1Database, args: { seed: number; rle: Uint8Array; score: number; ip: string }) {
  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': args.ip },
    body: JSON.stringify({
      seed: args.seed,
      rleBase64: base64(args.rle),
      score: args.score,
      stage: 2,
      name: 'COPYCAT',
      rulesetVersion: RULESET_VERSION,
      replayFormatVersion: REPLAY_FORMAT_VERSION,
    }),
  });
  type Ctx = Parameters<typeof postScore>[0];
  const response = await postScore({ request, env: { DB: db, RANKING_IP_HASH_KEY: IP_HASH_KEY }, params: {} } as unknown as Ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /api/scores: one row per effective seed (migrations/0005)', () => {
  let testDb: TestD1;
  beforeAll(async () => {
    testDb = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await testDb.dispose();
  });

  it('refuses a copied replay (same seed, altered inputs) against a verified row and against a pending row', async () => {
    const verifiedSeed = 4_000_001;
    const pendingSeed = 4_000_002;
    for (const [seed, status] of [
      [verifiedSeed, 'verified'],
      [pendingSeed, 'pending'],
    ] as const) {
      await seedScoreRow(testDb.db, {
        seed,
        status,
        score: 700,
        season_id: CURRENT_SEASON_ID,
        ruleset_version: RULESET_VERSION,
        inputs: rleFor(0),
        replay_hash: await computeReplayHash({ seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, seed, rle: rleFor(0) }),
      });
    }

    for (const seed of [verifiedSeed, pendingSeed]) {
      const copied = await post(testDb.db, { seed, rle: rleFor(1), score: 701, ip: '203.0.113.5' });
      expect(copied.status).toBe(409);
      expect(copied.body).toEqual({ error: 'duplicate replay', accepted: false });
    }
    const rows = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE seed IN (?1, ?2)`).bind(verifiedSeed, pendingSeed).first<{ c: number }>();
    expect(rows!.c).toBe(2);
  });

  // deriveStageSeed() collides for these two seeds, so a
  // replay recorded under one plays identically under the other. Neither the
  // numeric seed nor replay_hash can see that copy; rng_key can.
  it('refuses a copied replay re-submitted under a DIFFERENT seed that produces the same rng streams', async () => {
    const storedSeed = 1485211075;
    const collidingSeed = 2522981067;
    expect(collidingSeed).not.toBe(storedSeed);
    expect(computeRngKey(collidingSeed)).toBe(computeRngKey(storedSeed));

    await seedScoreRow(testDb.db, {
      seed: storedSeed,
      status: 'verified',
      score: 700,
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      inputs: rleFor(0),
      replay_hash: await computeReplayHash({ seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, seed: storedSeed, rle: rleFor(0) }),
    });

    // Same inputs AND altered inputs — both carry a replay_hash nobody has
    // stored (the hash includes the seed), and both must be refused.
    for (const variant of [0, 1]) {
      const copied = await post(testDb.db, { seed: collidingSeed, rle: rleFor(variant), score: 701, ip: '203.0.113.7' });
      expect(copied.status).toBe(409);
      expect(copied.body).toEqual({ error: 'duplicate replay', accepted: false });
    }
    const rows = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE rng_key = ?1`).bind(computeRngKey(storedSeed)).first<{ c: number }>();
    expect(rows!.c).toBe(1);
  });

  it('stores rng_key = computeRngKey(seed) on an accepted submission', async () => {
    const seed = 4_000_004;
    const { status } = await post(testDb.db, { seed, rle: rleFor(0), score: 701, ip: '203.0.113.8' });
    expect(status).toBe(200);
    const row = await testDb.db.prepare(`SELECT rng_key FROM scores WHERE seed = ?1`).bind(seed).first<{ rng_key: number }>();
    expect(row!.rng_key).toBe(computeRngKey(seed));
  });

  it('still accepts a run under a seed nobody has stored', async () => {
    const { status, body } = await post(testDb.db, { seed: 4_000_003, rle: rleFor(1), score: 701, ip: '203.0.113.6' });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
  });
});
