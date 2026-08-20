// Real-D1 integration tests for the 2026-08-20 "pending 統合表示" revision
// (docs/plans/2026-08-19-ranking-free-async spec items 5 and 6), driving the
// SHIPPED handlers (functions/api/ranking.ts, functions/api/scores.ts) against
// wrangler's local D1 — actual SQL, actual ordering, actual LIMITs.
//
// The headline requirement here is the ANTI-GRIEFING one (spec item 15b): a
// merged board is only safe if occupying it proves nothing about who may
// submit. Three fake pending rows can hold the top three DISPLAY slots, and a
// legitimate score that beats the verified 10th place — while losing badly to
// those fakes — must still be accepted. The fakes and the submitter use
// DIFFERENT IPs on purpose, so a pass here can never be the per-IP cap's 429
// wearing an "accepted" mask (asserted explicitly below).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { onRequestGet as getRanking } from '../../api/ranking';
import { onRequestPost as postScore } from '../../api/scores';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { encodeRle, type InputSample } from '../../../src/core/rle';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'merged-board-test-hmac-key';
const HOUR_MS = 60 * 60 * 1000;

interface DisplayEntry {
  id: string;
  score: number;
  status: 'pending' | 'verified';
  replayAvailable: boolean;
  xHandle: string | null;
}

function rleBase64For(seed: number): string {
  const samples: InputSample[] = [
    { dx: 1, dy: 0, drawHeld: false, slow: false },
    { dx: 0, dy: 1, drawHeld: true, slow: seed % 2 === 0 },
  ];
  let binary = '';
  for (const b of encodeRle(samples)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makeEnv(db: D1Database) {
  return {
    // Always-allowing KV stub: the non-atomic KV rate limiter is a separate
    // layer with its own tests, and it must not decide the outcome here.
    SHARES: { get: async () => null, put: async () => undefined },
    DB: db,
    RANKING_IP_HASH_KEY: IP_HASH_KEY,
  };
}

async function post(db: D1Database, args: { seed: number; score: number; ip: string; name?: string }) {
  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': args.ip },
    body: JSON.stringify({
      seed: args.seed,
      rleBase64: rleBase64For(args.seed),
      score: args.score,
      stage: 3,
      name: args.name ?? `P${args.seed}`,
      rulesetVersion: RULESET_VERSION,
      replayFormatVersion: REPLAY_FORMAT_VERSION,
    }),
  });
  type Ctx = Parameters<typeof postScore>[0];
  const response = await postScore({ request, env: makeEnv(db), params: {} } as unknown as Ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function ranking(db: D1Database) {
  type Ctx = Parameters<typeof getRanking>[0];
  const response = await getRanking({ env: makeEnv(db), params: {} } as unknown as Ctx);
  return (await response.json()) as { entries: { id: string; score: number }[]; displayEntries: DisplayEntry[] };
}

/** 10 verified rows scoring 1000, 990, ... 910 — so the 10th place a submitter must beat is exactly 910. */
async function seedVerifiedTen(db: D1Database): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await seedScoreRow(db, {
      id: `verified-${i}`,
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      replay_format_version: REPLAY_FORMAT_VERSION,
      score: 1000 - i * 10,
      status: 'verified',
      name: `VERIFIED${i}`,
    });
  }
}

const VERIFIED_TENTH_SCORE = 910;

/** Three pending rows claiming absurd scores, all from ONE attacker IP hash — the display-occupation attack. */
async function seedFakePendingThree(db: D1Database): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(
      await seedScoreRow(db, {
        id: `fake-pending-${i}`,
        season_id: CURRENT_SEASON_ID,
        ruleset_version: RULESET_VERSION,
        replay_format_version: REPLAY_FORMAT_VERSION,
        score: 999_000 - i,
        status: 'pending',
        ip_hash: 'attacker-ip-hash',
        name: `FAKE${i}`,
      })
    );
  }
  return ids;
}

describe('merged display board + submission independence (real local D1)', () => {
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

  it('anti-griefing: a score above the verified 10th place is ACCEPTED even though 3 fake pending rows own the top display slots', async () => {
    await seedVerifiedTen(testDb.db);
    const fakeIds = await seedFakePendingThree(testDb.db);

    // Precondition: the fakes really do occupy the display board's top three.
    const before = await ranking(testDb.db);
    expect(before.displayEntries.slice(0, 3).map((e) => e.id)).toEqual(fakeIds);
    expect(before.displayEntries.slice(0, 3).every((e) => e.status === 'pending')).toBe(true);
    // ...and the submission basis is untouched by them.
    expect(before.entries).toHaveLength(10);
    expect(before.entries[9].score).toBe(VERIFIED_TENTH_SCORE);

    // The honest submission: comfortably above the verified 10th place,
    // hopelessly below every fake. A DIFFERENT IP from the attacker's, so
    // the per-IP pending cap cannot be what decides this.
    const { status, body } = await post(testDb.db, { seed: 91_001, score: VERIFIED_TENTH_SCORE + 5, ip: '198.51.100.7' });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.status).toBe('pending');

    // Explicitly NOT a 429 in disguise: the honest submitter's IP had no
    // pending rows of its own before this, and has exactly one after.
    const ownRows = await testDb.db
      .prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending' AND ip_hash NOT IN ('attacker-ip-hash')`)
      .first<{ c: number }>();
    expect(ownRows!.c).toBe(1);
  });

  it('anti-griefing: even 3 fake pending rows PLUS a full 200-row global backlog only ever cost a submission the 429 path, never the eligibility gate', async () => {
    // Complementary negative control for the test above: the gate itself
    // (score vs verified 10th) is what a submission is judged on, and the
    // display board plays no part — a submission at/below 10th place is
    // refused with `accepted:false` + out-of-range, not with a cap error,
    // no matter what the board looks like.
    await seedVerifiedTen(testDb.db);
    await seedFakePendingThree(testDb.db);

    const tie = await post(testDb.db, { seed: 92_001, score: VERIFIED_TENTH_SCORE, ip: '198.51.100.8' });
    expect(tie.status).toBe(200);
    expect(tie.body.accepted).toBe(false);
    expect(tie.body.reason).toBe('out-of-range');

    const below = await post(testDb.db, { seed: 92_002, score: VERIFIED_TENTH_SCORE - 1, ip: '198.51.100.9' });
    expect(below.body.accepted).toBe(false);

    // Neither refusal consumed a pending slot.
    const pending = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    expect(pending!.c).toBe(3); // the three fakes, and nothing else
  });

  it('an accepted submission appears on the merged board at its real position, tagged pending', async () => {
    await seedVerifiedTen(testDb.db);
    const { body } = await post(testDb.db, { seed: 93_001, score: 995, ip: '198.51.100.10', name: 'HONEST' });
    const id = body.id as string;

    const { entries, displayEntries } = await ranking(testDb.db);
    // 995 sits between verified-0 (1000) and verified-1 (990) -> display #2.
    expect(displayEntries[1].id).toBe(id);
    expect(displayEntries[1].status).toBe('pending');
    expect(displayEntries).toHaveLength(10);
    // The confirmed board never saw it.
    expect(entries.map((e) => e.id)).not.toContain(id);
  });

  it('verified-ing a pending row keeps its position and only drops the badge (nothing else changed)', async () => {
    await seedVerifiedTen(testDb.db);
    const { body } = await post(testDb.db, { seed: 94_001, score: 995, ip: '198.51.100.11' });
    const id = body.id as string;

    const before = await ranking(testDb.db);
    const positionBefore = before.displayEntries.findIndex((e) => e.id === id);
    expect(before.displayEntries[positionBefore].status).toBe('pending');

    // Exactly what the audit job does on a confirmed row.
    await testDb.db.prepare(`UPDATE scores SET status = 'verified' WHERE id = ?1`).bind(id).run();

    const after = await ranking(testDb.db);
    expect(after.displayEntries.findIndex((e) => e.id === id)).toBe(positionBefore);
    expect(after.displayEntries[positionBefore].status).toBe('verified');
    expect(after.displayEntries.map((e) => e.id)).toEqual(before.displayEntries.map((e) => e.id));
    // And now it counts towards the submission basis, which it did not before.
    expect(after.entries.map((e) => e.id)).toContain(id);
  });

  it('an expired pending row is invisible on the merged board AND uncounted by the caps (one 24h boundary, both readers)', async () => {
    await seedScoreRow(testDb.db, {
      id: 'expired-pending',
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      replay_format_version: REPLAY_FORMAT_VERSION,
      score: 999_999,
      status: 'pending',
      ip_hash: 'shared-ip-hash',
      created_at: Date.now() - 25 * HOUR_MS,
    });
    await seedScoreRow(testDb.db, {
      id: 'fresh-pending',
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      replay_format_version: REPLAY_FORMAT_VERSION,
      score: 500,
      status: 'pending',
      created_at: Date.now() - 1 * HOUR_MS,
    });

    const { displayEntries } = await ranking(testDb.db);
    expect(displayEntries.map((e) => e.id)).toEqual(['fresh-pending']); // the 999,999 row is simply not there
    // The row is still physically present — expiry is a read-side exclusion;
    // deleting it is the audit job's own opening step.
    const stillThere = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE id = 'expired-pending'`).first<{ c: number }>();
    expect(stillThere!.c).toBe(1);
  });

  it('display pending candidates are capped at 3 against real SQL, even with 6 fresh pending rows and no verified rows at all', async () => {
    for (let i = 0; i < 6; i++) {
      await seedScoreRow(testDb.db, {
        id: `p-${i}`,
        season_id: CURRENT_SEASON_ID,
        ruleset_version: RULESET_VERSION,
        replay_format_version: REPLAY_FORMAT_VERSION,
        score: 500 - i,
        status: 'pending',
      });
    }
    const { entries, displayEntries } = await ranking(testDb.db);
    expect(entries).toEqual([]);
    expect(displayEntries.map((e) => e.id)).toEqual(['p-0', 'p-1', 'p-2']);
  });

  it('with no verified rows the pre-gate passes unconditionally, and the accepted row shows up on the board', async () => {
    const { status, body } = await post(testDb.db, { seed: 95_001, score: 0, ip: '198.51.100.12' });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true); // COALESCE(10th, -1): score 0 > -1

    const { displayEntries } = await ranking(testDb.db);
    expect(displayEntries.map((e) => [e.id, e.status])).toEqual([[body.id, 'pending']]);
  });
});
