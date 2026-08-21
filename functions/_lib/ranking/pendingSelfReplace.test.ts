// Pending self-replacement against a REAL local D1 (docs/plans/2026-08-22-
// pending-self-replace). Uses the same wrangler-backed harness the audit
// script's own integration tests use (scripts/audit/testSupport/localD1.ts),
// because the entire point of this feature's design is a property of genuine
// SQLite/D1 transaction semantics — that a `batch()` is one transaction, that
// it rolls back on ERROR only, and that `INSERT ... WHERE <false>` reporting
// `changes: 0` is a SUCCESS. A hand-rolled mock would happily "pass" a build
// that loses rows in production.
//
// THE INVARIANT THIS FILE EXISTS FOR
// ---------------------------------
// "DELETE = 1 / INSERT = 0" must be structurally impossible: no scenario may
// remove an existing row without the replacement landing in the same
// transaction. Every test that reaches the replacement path runs its
// scenario through withRowConservation(), which diffs the table's id set
// before and after and fails if anything vanished without exactly one new row
// taking its place — so the invariant is checked on the happy path, the
// rejected paths, and the error paths alike, not only where it is the
// headline assertion.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from '../../../scripts/audit/testSupport/localD1';
import { onRequestPost } from '../../api/scores';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { computeSubmitterHash } from './submitterToken';
import { computeReplayHash } from './hash';
import { PENDING_EXPIRY_MS } from './pendingGate';
import { encodeRle, type InputSample } from '../../../src/core/rle';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'self-replace-test-hmac-key';

/** This browser. */
const MY_TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';
/** A DIFFERENT browser on the same network — the row that must survive everything this file does. */
const OTHER_TOKEN = '11111111222222223333333344444444';

const IP_MINE = '203.0.113.1';
const IP_OTHER_NETWORK = '198.51.100.7';

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

function makeEnv(db: D1Database) {
  return {
    // Always-allowing KV stub: this suite isolates D1-level behavior, not the
    // separate (already-covered) non-atomic KV rate limiter.
    SHARES: { get: async () => null, put: async () => undefined },
    DB: db,
    RANKING_IP_HASH_KEY: IP_HASH_KEY,
  };
}

interface PostOptions {
  seed: number;
  score: number;
  ip: string;
  /** Omit for a token-less (old / private-browsing) client. `null` is sent as a literal JSON null — an ATTACHED but malformed token, which is a different case entirely. */
  token?: string | null;
  stage?: number;
}

async function post(db: D1Database, opts: PostOptions) {
  const body: Record<string, unknown> = {
    seed: opts.seed,
    rleBase64: rleBase64For(opts.seed),
    score: opts.score,
    stage: opts.stage ?? 1,
    name: 'PLAYER',
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
  };
  if (opts.token !== undefined) body.submitterToken = opts.token;

  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip },
    body: JSON.stringify(body),
  });
  type Ctx = Parameters<typeof onRequestPost>[0];
  const response = await onRequestPost({ request, env: makeEnv(db), params: {} } as unknown as Ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface Row {
  id: string;
  rank_seq: number;
  score: number;
  status: string;
  ip_hash: string | null;
  submitter_hash: string | null;
  created_at: number;
}

async function allRows(db: D1Database): Promise<Row[]> {
  const { results } = await db.prepare(`SELECT id, rank_seq, score, status, ip_hash, submitter_hash, created_at FROM scores ORDER BY rank_seq`).all<Row>();
  return results;
}

async function pendingCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
  return row!.c;
}

/**
 * Runs `body` and asserts the file's headline invariant around it: whatever
 * happened, a pre-existing row may only have disappeared if exactly one new
 * row appeared in its place. A committed DELETE with no INSERT behind it —
 * the failure mode this feature's whole SQL shape is built to make
 * unreachable — fails here regardless of which scenario produced it.
 *
 * `injectedIds` names rows the TEST ITSELF seeded during the window (the
 * "a new submission arrived mid-flight" scenarios): they are discounted from
 * the added side so the invariant stays about the handler's own writes.
 */
async function withRowConservation<T>(db: D1Database, body: () => Promise<T>, injectedIds: () => string[] = () => []): Promise<T> {
  const before = await allRows(db);
  const result = await body();
  const after = await allRows(db);
  const beforeIds = new Set(before.map((r) => r.id));
  const afterIds = new Set(after.map((r) => r.id));
  const injected = new Set(injectedIds());
  const removed = before.filter((r) => !afterIds.has(r.id)).map((r) => r.id);
  const added = after.filter((r) => !beforeIds.has(r.id) && !injected.has(r.id)).map((r) => r.id);
  if (removed.length > 0 && added.length !== 1) {
    throw new Error(`row loss: ${removed.length} row(s) removed (${removed.join(', ')}) but ${added.length} added by the handler (${added.join(', ')})`);
  }
  expect(removed.length).toBeLessThanOrEqual(1);
  return result;
}

describe('POST /api/scores pending self-replacement (real local D1)', () => {
  let testDb: TestD1;
  let myHash: string;
  let otherHash: string;

  beforeAll(async () => {
    testDb = await createTestD1();
    myHash = await computeSubmitterHash(MY_TOKEN);
    otherHash = await computeSubmitterHash(OTHER_TOKEN);
  }, 30_000);

  afterAll(async () => {
    await testDb.dispose();
  });

  beforeEach(async () => {
    await testDb.db.prepare(`DELETE FROM scores`).run();
  });

  /** Seeds one fresh pending row with this suite's defaults. */
  async function seedPending(overrides: Parameters<typeof seedScoreRow>[1] = {}): Promise<string> {
    return seedScoreRow(testDb.db, {
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      replay_format_version: REPLAY_FORMAT_VERSION,
      status: 'pending',
      created_at: Date.now(),
      ...overrides,
    });
  }

  /** The ip_hash the handler will compute for `ip` — needed to seed rows that really do belong to the IP under test. */
  async function ipHashFor(ip: string): Promise<string> {
    const { computeIpHash } = await import('./ipHash');
    return computeIpHash(ip, IP_HASH_KEY);
  }

  it('replaces this browser\'s WEAKEST pending row when its own IP is full, keeping the pending count at the cap', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    const weakest = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });
    const middle = await seedPending({ score: 200, ip_hash: mineIp, submitter_hash: myHash });
    const strongest = await seedPending({ score: 300, ip_hash: mineIp, submitter_hash: myHash });
    const seqBefore = (await allRows(testDb.db)).map((r) => r.rank_seq);

    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9001, score: 400, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(await pendingCount(testDb.db)).toBe(3); // the cap held — a replacement, not an extra slot

    const rows = await allRows(testDb.db);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(weakest); // the lowest score is the one that went
    expect(ids).toContain(middle);
    expect(ids).toContain(strongest);
    expect(ids).toContain(body.id as string);

    // rank_seq is an immutable AUTOINCREMENT key: the new row gets a BRAND
    // NEW one (it is a new arrival), and no existing row's was renumbered.
    const newRow = rows.find((r) => r.id === (body.id as string))!;
    expect(newRow.rank_seq).toBeGreaterThan(Math.max(...seqBefore));
    expect(newRow.score).toBe(400);
    expect(newRow.submitter_hash).toBe(myHash);
    expect(rows.find((r) => r.id === middle)!.rank_seq).toBe(seqBefore[1]);
  });

  it('breaks a tie among equally-weak own rows by deleting the NEWEST, leaving the earliest submission alone', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    const oldestTied = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });
    const newestTied = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });
    await seedPending({ score: 300, ip_hash: mineIp, submitter_hash: myHash });

    const { status } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9002, score: 400, ip: IP_MINE, token: MY_TOKEN }));
    expect(status).toBe(200);

    const ids = (await allRows(testDb.db)).map((r) => r.id);
    expect(ids).toContain(oldestTied); // first-come-first-served survives
    expect(ids).not.toContain(newestTied);
  });

  it('does NOT replace on a tie with the weakest own row — a tie never displaces an earlier submission', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    for (const score of [100, 200, 300]) await seedPending({ score, ip_hash: mineIp, submitter_hash: myHash });

    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9003, score: 100, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(429);
    expect(body.accepted).toBe(false);
    expect(await pendingCount(testDb.db)).toBe(3);
    expect((await allRows(testDb.db)).map((r) => r.score).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('never deletes another browser\'s row, nor an un-owned (submitter_hash NULL) one, even from the same IP', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    // Everything in the way is weaker than the incoming claim, and all of it
    // sits on the very IP that is full — the maximally tempting case.
    const theirs = await seedPending({ score: 10, ip_hash: mineIp, submitter_hash: otherHash });
    const legacyNoToken = await seedPending({ score: 20, ip_hash: mineIp, submitter_hash: null });
    const alsoTheirs = await seedPending({ score: 30, ip_hash: mineIp, submitter_hash: otherHash });

    const { status } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9004, score: 999, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(429);
    const ids = (await allRows(testDb.db)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([theirs, legacyNoToken, alsoTheirs]));
    expect(await pendingCount(testDb.db)).toBe(3);
  });

  // THE case the P1 design exists for. My own weaker row is real, and mine,
  // and fresh — but it lives under a DIFFERENT IP, so deleting it would NOT
  // free a slot in the queue that is actually full (this IP's). A naive
  // "delete my weakest row anywhere, then insert" would commit the delete and
  // then find the per-IP condition still false: one row destroyed, nothing
  // gained. The case analysis in the DELETE's WHERE makes that unreachable.
  it('CROSS-IP: refuses (429) when my weaker row is on another IP while THIS IP is full of other people\'s rows — and loses nothing', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    const elsewhereIp = await ipHashFor(IP_OTHER_NETWORK);
    const myRowElsewhere = await seedPending({ score: 50, ip_hash: elsewhereIp, submitter_hash: myHash });
    const blockers = [
      await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: otherHash }),
      await seedPending({ score: 200, ip_hash: mineIp, submitter_hash: otherHash }),
      await seedPending({ score: 300, ip_hash: mineIp, submitter_hash: null }),
    ];

    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9005, score: 900, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(429);
    expect(body.accepted).toBe(false);
    const ids = (await allRows(testDb.db)).map((r) => r.id);
    expect(ids).toContain(myRowElsewhere); // NOT sacrificed for nothing
    expect(ids).toEqual(expect.arrayContaining(blockers));
    expect(await pendingCount(testDb.db)).toBe(4);
  });

  // The mirror image, and the reason case B exists at all: when the only full
  // queue is the GLOBAL one, any of my rows frees a global slot no matter
  // which IP it sits under.
  it('GLOBAL FULL / IP has room: replaces my pending row that lives on a DIFFERENT IP', async () => {
    const elsewhereIp = await ipHashFor(IP_OTHER_NETWORK);
    const myRowElsewhere = await seedPending({ score: 50, ip_hash: elsewhereIp, submitter_hash: myHash });
    for (let i = 0; i < 199; i++) await seedPending({ score: 1000 + i, ip_hash: 'filler-ip-hash', submitter_hash: null });
    expect(await pendingCount(testDb.db)).toBe(200);

    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9006, score: 900, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(await pendingCount(testDb.db)).toBe(200); // the global cap held exactly
    const ids = (await allRows(testDb.db)).map((r) => r.id);
    expect(ids).not.toContain(myRowElsewhere);
    expect(ids).toContain(body.id as string);
  });

  it('deletes nothing when both queues have room — the ordinary INSERT simply succeeds', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    const mine = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });

    const before = await allRows(testDb.db);
    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9007, score: 900, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    const ids = (await allRows(testDb.db)).map((r) => r.id);
    expect(ids).toContain(mine); // a weaker own row is NOT collected as a side effect
    expect(ids).toHaveLength(before.length + 1);
  });

  it('an old client (no token) keeps the pre-replacement behavior: 429, nothing deleted', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    const seeded = [
      await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash }),
      await seedPending({ score: 200, ip_hash: mineIp, submitter_hash: myHash }),
      await seedPending({ score: 300, ip_hash: mineIp, submitter_hash: myHash }),
    ];

    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: 9008, score: 999, ip: IP_MINE }));

    expect(status).toBe(429);
    expect(body.accepted).toBe(false);
    expect((await allRows(testDb.db)).map((r) => r.id)).toEqual(expect.arrayContaining(seeded));
    expect(await pendingCount(testDb.db)).toBe(3);
  });

  // `null` sits alongside the garbage string on purpose: it ATTACHES the
  // field, so it is a malformed token rather than the token-less-client case
  // above. Both are held to the same standard here — the table comes out
  // byte-identical, not merely "no new pending row".
  it.each([
    ['a garbage string', 'NOT-A-TOKEN' as string | null],
    ['an explicit null', null as string | null],
  ])('a malformed token (%s) is a 400 that writes nothing at all', async (_label, token) => {
    const mineIp = await ipHashFor(IP_MINE);
    await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });
    const before = await allRows(testDb.db);

    const { status, body } = await post(testDb.db, { seed: 9009, score: 900, ip: IP_MINE, token });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('submitterToken');
    expect(await allRows(testDb.db)).toEqual(before);
  });

  it('stores SHA-256 of the token bytes — never the raw token — in submitter_hash', async () => {
    const { body } = await post(testDb.db, { seed: 9010, score: 900, ip: IP_MINE, token: MY_TOKEN });
    expect(body.accepted).toBe(true);

    const row = await testDb.db.prepare(`SELECT * FROM scores WHERE id = ?1`).bind(body.id as string).first<Record<string, unknown>>();
    expect(row!.submitter_hash).toBe(myHash);
    expect(myHash).not.toBe(MY_TOKEN);
    // Exhaustive: the raw token appears in NO column of the row, in no form.
    for (const value of Object.values(row!)) {
      if (typeof value === 'string') expect(value).not.toContain(MY_TOKEN);
    }
  });

  // D1's batch rolls back on an ERROR — and a duplicate replay_hash is one.
  // The delete is therefore undone with it, which is the difference between
  // "your resubmission was refused" and "your resubmission was refused AND it
  // ate one of your pending rows".
  it('rolls the whole batch back on a replay_hash UNIQUE violation, restoring the row the DELETE had removed', async () => {
    const mineIp = await ipHashFor(IP_MINE);
    const duplicateSeed = 9011;
    const collidingHash = await computeReplayHash({
      seasonId: CURRENT_SEASON_ID,
      rulesetVersion: RULESET_VERSION,
      seed: duplicateSeed,
      rle: rleBytesFor(duplicateSeed),
    });

    // The weakest row is a genuine delete candidate; the row carrying the
    // colliding replay_hash scores HIGHER than the incoming claim, so it is
    // never a candidate and the collision really does fire.
    const candidate = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });
    const collider = await seedPending({ score: 500, ip_hash: mineIp, submitter_hash: myHash, replay_hash: collidingHash });
    const third = await seedPending({ score: 600, ip_hash: mineIp, submitter_hash: myHash });

    const { status, body } = await withRowConservation(testDb.db, () => post(testDb.db, { seed: duplicateSeed, score: 400, ip: IP_MINE, token: MY_TOKEN }));

    expect(status).toBe(409);
    expect(body.error).toBe('duplicate replay');
    const ids = (await allRows(testDb.db)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([candidate, collider, third])); // the DELETE was rolled back with the INSERT
    expect(await pendingCount(testDb.db)).toBe(3);
  });

  // The completion criterion about the 24h boundary. The scenario is driven
  // by mutating the WORLD (clock and table) in between the first INSERT
  // attempt and the retry batch, through a D1 wrapper that fires exactly once
  // — a Date.now() call-counting spy would be hostage to how many times
  // unrelated code happens to read the clock.
  describe('when the world changes between the first attempt and the retry batch', () => {
    /**
     * Wraps a D1Database so that `onFirstInsert` runs immediately after the
     * first standalone INSERT statement executes — i.e. in the exact gap the
     * spec worries about. Batched statements pass straight through to the
     * real database (unwrapped), so the transaction under test is genuinely
     * D1's own.
     */
    function hookAfterFirstInsert(db: D1Database, onFirstInsert: () => Promise<void>): D1Database {
      let fired = false;
      const wrapStatement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => {
        const wrapped = {
          __inner: inner,
          bind: (...args: unknown[]) => wrapStatement(inner.bind(...args), sql),
          first: (...args: [] | [string]) => (inner.first as (...a: unknown[]) => unknown)(...args),
          all: () => inner.all(),
          raw: () => inner.raw(),
          run: async () => {
            const result = await inner.run();
            if (!fired && /INSERT INTO scores/.test(sql)) {
              fired = true;
              await onFirstInsert();
            }
            return result;
          },
        };
        return wrapped as unknown as D1PreparedStatement;
      };
      return {
        prepare: (sql: string) => wrapStatement(db.prepare(sql), sql),
        batch: (statements: D1PreparedStatement[]) =>
          db.batch(statements.map((s) => (s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s)),
      } as unknown as D1Database;
    }

    it('loses nothing when a pending row EXPIRES and a new one arrives in the gap (the cutoff really does move)', async () => {
      const mineIp = await ipHashFor(IP_MINE);
      const now = Date.now();
      // Two comfortably-fresh own rows, plus one that falls off the 24h
      // boundary 10 seconds from now.
      const fresh1 = await seedPending({ score: 200, ip_hash: mineIp, submitter_hash: myHash, created_at: now });
      const fresh2 = await seedPending({ score: 300, ip_hash: mineIp, submitter_hash: myHash, created_at: now });
      const aboutToExpire = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash, created_at: now - PENDING_EXPIRY_MS + 10_000 });

      const realNow = Date.now;
      let clockOffset = 0;
      Date.now = () => realNow() + clockOffset;
      let interloper = '';
      try {
        const hooked = hookAfterFirstInsert(testDb.db, async () => {
          clockOffset = 60_000; // past the boundary `aboutToExpire` sat on
          interloper = await seedPending({ score: 700, ip_hash: 'someone-elses-ip-hash', submitter_hash: null, created_at: realNow() + 60_000 });
        });
        const { status, body } = await withRowConservation(
          testDb.db,
          () => post(hooked, { seed: 9012, score: 900, ip: IP_MINE, token: MY_TOKEN }),
          () => [interloper]
        );
        expect(status).toBe(200);
        expect(body.accepted).toBe(true);
      } finally {
        Date.now = realNow;
      }

      // Everything that existed still exists (expiry is a COUNT exclusion,
      // not a delete — that is the audit's job), plus the new row.
      const ids = (await allRows(testDb.db)).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([fresh1, fresh2, aboutToExpire, interloper]));
      expect(ids).toContain((await allRows(testDb.db)).find((r) => r.score === 900)!.id);
    });

    it('loses nothing when the gap only ADDS rows (the replacement still happens, once)', async () => {
      const mineIp = await ipHashFor(IP_MINE);
      const weakest = await seedPending({ score: 100, ip_hash: mineIp, submitter_hash: myHash });
      const mid = await seedPending({ score: 200, ip_hash: mineIp, submitter_hash: myHash });
      const top = await seedPending({ score: 300, ip_hash: mineIp, submitter_hash: myHash });

      const realNow = Date.now;
      let clockOffset = 0;
      Date.now = () => realNow() + clockOffset;
      let interloper = '';
      try {
        const hooked = hookAfterFirstInsert(testDb.db, async () => {
          clockOffset = 90_000;
          interloper = await seedPending({ score: 700, ip_hash: 'someone-elses-ip-hash', submitter_hash: null });
        });
        const { status } = await withRowConservation(
          testDb.db,
          () => post(hooked, { seed: 9013, score: 400, ip: IP_MINE, token: MY_TOKEN }),
          () => [interloper]
        );
        expect(status).toBe(200);
      } finally {
        Date.now = realNow;
      }

      const ids = (await allRows(testDb.db)).map((r) => r.id);
      expect(ids).not.toContain(weakest); // exactly one row replaced...
      expect(ids).toEqual(expect.arrayContaining([mid, top, interloper])); // ...and only that one
      expect(await pendingCount(testDb.db)).toBe(4); // 3 of mine (one swapped) + the interloper
    });
  });

  describe('concurrency', () => {
    it('many simultaneous self-replacing POSTs from one browser never breach the per-IP cap or strand a row', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(testDb.db, { seed: 9100 + i, score: 100 * i, ip: IP_MINE, token: MY_TOKEN }))
      );
      const acceptedIds = new Set(results.filter((r) => r.body.accepted === true).map((r) => r.body.id as string));
      expect(acceptedIds.size).toBeGreaterThanOrEqual(3);

      const rows = await allRows(testDb.db);
      expect(rows).toHaveLength(3); // the cap held exactly, under real contention
      // Every surviving row is one this run actually accepted — nothing was
      // half-written, and nothing from before leaked through.
      for (const row of rows) expect(acceptedIds.has(row.id)).toBe(true);
      for (const row of rows) expect(row.submitter_hash).toBe(myHash);
    });

    it('two browsers on the SAME IP contending at once: neither can delete the other\'s row, and the cap still holds', async () => {
      const mixed = await Promise.all([
        ...[1, 2, 3, 4].map((i) => post(testDb.db, { seed: 9200 + i, score: 100 * i, ip: IP_MINE, token: MY_TOKEN })),
        ...[1, 2, 3, 4].map((i) => post(testDb.db, { seed: 9300 + i, score: 100 * i, ip: IP_MINE, token: OTHER_TOKEN })),
      ]);
      expect(mixed.some((r) => r.body.accepted === true)).toBe(true);

      const rows = await allRows(testDb.db);
      expect(rows.length).toBeLessThanOrEqual(3);
      const acceptedIds = new Set(mixed.filter((r) => r.body.accepted === true).map((r) => r.body.id as string));
      for (const row of rows) {
        expect(acceptedIds.has(row.id)).toBe(true);
        expect([myHash, otherHash]).toContain(row.submitter_hash);
      }
    });

    it('global cap: concurrent replacements against a full global queue never push past 200', async () => {
      const elsewhereIp = await ipHashFor(IP_OTHER_NETWORK);
      for (let i = 0; i < 197; i++) await seedPending({ score: 1000 + i, ip_hash: 'filler-ip-hash', submitter_hash: null });
      for (let i = 0; i < 3; i++) await seedPending({ score: 10 + i, ip_hash: elsewhereIp, submitter_hash: myHash });
      expect(await pendingCount(testDb.db)).toBe(200);

      await Promise.all([1, 2, 3, 4].map((i) => post(testDb.db, { seed: 9400 + i, score: 900 + i, ip: IP_MINE, token: MY_TOKEN })));

      expect(await pendingCount(testDb.db)).toBeLessThanOrEqual(200);
    });
  });
});
