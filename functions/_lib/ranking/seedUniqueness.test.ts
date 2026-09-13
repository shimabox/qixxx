// End-to-end check of migrations/0005 through the real POST handler on a real
// local D1: a copied replay — same seed as a stored row, inputs altered so the
// replay_hash is new — is refused as a duplicate, while a run under a fresh
// seed is accepted as usual.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { onRequestPost as postScore } from '../../api/scores';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { computeReplayHash } from './hash';
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

describe('POST /api/scores: one row per seed (migrations/0005)', () => {
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

  it('still accepts a run under a seed nobody has stored', async () => {
    const { status, body } = await post(testDb.db, { seed: 4_000_003, rle: rleFor(1), score: 701, ip: '203.0.113.6' });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
  });
});
