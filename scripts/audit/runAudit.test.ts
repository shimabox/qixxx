// Real-D1 integration tests for the async audit orchestration.
// Runs against an
// actual local D1 database (scripts/audit/testSupport/localD1.ts), not a
// mock, so D1/SQLite's own transaction/UNIQUE-constraint/AUTOINCREMENT
// semantics are exercised for real.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestD1, seedScoreRow, type TestD1 } from './testSupport/localD1';
import { runAudit, type AuditEvent } from './runAudit';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import type { AuditD1BindValue, AuditD1Database } from './d1Adapter';

const SEASON_ID = 1;
const RULESET_VERSION = 1;
const REPLAY_FORMAT_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;

function baseOptions(db: AuditD1Database, overrides: Partial<Parameters<typeof runAudit>[0]> = {}) {
  return {
    db,
    seasonId: SEASON_ID,
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    ...overrides,
  };
}

/** A short, real, gameover-reaching replay recorded through the actual core simulator. */
function recordRealReplay(seed: number): { rle: Uint8Array; score: number; stage: number; durationTicks: number } {
  const session = new GameSession({ seed });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard < 20000) {
    const input: InputSample = { dx: 0, dy: 1, drawHeld: true, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
    guard++;
  }
  if (session.getStatus() !== 'gameover') throw new Error('fixture setup failed: did not reach gameover');
  return { rle: encodeRle(samples), score: session.getScore(), stage: session.getStage(), durationTicks: session.getTotalTicks() };
}

describe('runAudit (real local D1)', () => {
  let testDb: TestD1;

  beforeAll(async () => {
    testDb = await createTestD1();
  }, 30_000);

  afterAll(async () => {
    await testDb.dispose();
  });

  // Every test seeds exactly the rows it needs — a clean `scores` table
  // beforehand keeps tests independent of each other's leftover verified/
  // pending rows (in particular, the TOP10-cleanup test's ranking would
  // otherwise be polluted by verified rows an earlier test produced). Does
  // NOT touch `audit_lock` — several tests deliberately depend on its state
  // carrying over from runAudit()'s own acquire/release behavior.
  beforeEach(async () => {
    await testDb.db.prepare(`DELETE FROM scores`).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function pendingCount(): Promise<number> {
    const row = await testDb.db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE status = 'pending'`).first<{ c: number }>();
    return row!.c;
  }

  async function statusOf(id: string): Promise<string | null> {
    const row = await testDb.db.prepare(`SELECT status FROM scores WHERE id = ?`).bind(id).first<{ status: string }>();
    return row?.status ?? null;
  }

  it('a fresh, empty database: acquires, processes nothing, releases cleanly', async () => {
    const result = await runAudit(baseOptions(testDb.db));
    expect(result.acquired).toBe(true);
    expect(result.processedCount).toBe(0);
    expect(result.verifiedCount).toBe(0);
    expect(result.leaseLostMidRun).toBe(false);
    expect(result.lockReleased).toBe(true); // held its own lease all the way through, and gave it back
  });

  it('does not acquire (and touches nothing) while another run already holds the lock', async () => {
    await testDb.db.prepare(`UPDATE audit_lock SET owner_token = 'someone-else', locked_until = unixepoch() + 600 WHERE id = 1`).run();
    const id = await seedScoreRow(testDb.db, { status: 'pending' });
    const result = await runAudit(baseOptions(testDb.db));
    expect(result.acquired).toBe(false);
    expect(await statusOf(id)).toBe('pending'); // untouched
    // Release for subsequent tests.
    await testDb.db.prepare(`UPDATE audit_lock SET owner_token = NULL, locked_until = unixepoch() - 1 WHERE id = 1`).run();
    await testDb.db.prepare(`DELETE FROM scores WHERE id = ?`).bind(id).run();
  });

  it('can acquire the lock after a previous (crashed) run left it expired', async () => {
    await testDb.db.prepare(`UPDATE audit_lock SET owner_token = 'a-dead-run', locked_until = unixepoch() - 100 WHERE id = 1`).run();
    const result = await runAudit(baseOptions(testDb.db));
    expect(result.acquired).toBe(true);
  });

  it('deletes a pending row older than 24 hours at the start of the run, and counts it', async () => {
    const staleId = await seedScoreRow(testDb.db, { status: 'pending', created_at: Date.now() - 25 * HOUR_MS });
    const freshId = await seedScoreRow(testDb.db, { status: 'pending', created_at: Date.now() - 1000 });
    const result = await runAudit(baseOptions(testDb.db));
    expect(result.expiredDeletedCount).toBeGreaterThanOrEqual(1);
    expect(await statusOf(staleId)).toBeNull();
    // The fresh row should still exist (may since have been processed/deleted
    // by the same run's malformed-input verification — it was seeded with the
    // default malformed-looking 2-byte `inputs`, so it too gets consumed as
    // confirmed-invalid; only its ABSENCE-FROM-being-counted-as-expired matters
    // here).
    expect(result.expiredDeletedCount).toBe(1);
    await testDb.db.prepare(`DELETE FROM scores WHERE id = ?`).bind(freshId).run();
  });

  describe('pending -> verified / deleted classification', () => {
    it('confirms a genuinely valid pending replay as verified, overwriting score/stage/duration with the resimulated values', async () => {
      const seed = 9001;
      const fixture = recordRealReplay(seed);
      const id = await seedScoreRow(testDb.db, {
        status: 'pending',
        seed,
        inputs: fixture.rle,
        score: fixture.score,
        stage: fixture.stage,
        duration_ticks: fixture.durationTicks,
        ruleset_version: RULESET_VERSION,
        replay_format_version: REPLAY_FORMAT_VERSION,
      });
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.verifiedCount).toBeGreaterThanOrEqual(1);
      const row = await testDb.db.prepare(`SELECT status, score, stage, duration_ticks FROM scores WHERE id = ?`).bind(id).first<{
        status: string;
        score: number;
        stage: number;
        duration_ticks: number;
      }>();
      expect(row).toEqual({ status: 'verified', score: fixture.score, stage: fixture.stage, duration_ticks: fixture.durationTicks });
    });

    // The browser
    // ownership token exists ONLY to let a POST replace its own not-yet-
    // audited row. A verified row is never replaceable, so keeping the hash
    // on it would leave a durable, cross-session browser identifier sitting
    // in a table whose contents are partly public — for no functional gain.
    // The verified-flip therefore clears it in the same UPDATE.
    it('clears submitter_hash when it confirms a row, so the ownership token never outlives the pending window', async () => {
      const seed = 9002;
      const fixture = recordRealReplay(seed);
      const id = await seedScoreRow(testDb.db, {
        status: 'pending',
        seed,
        inputs: fixture.rle,
        score: fixture.score,
        stage: fixture.stage,
        duration_ticks: fixture.durationTicks,
        ruleset_version: RULESET_VERSION,
        replay_format_version: REPLAY_FORMAT_VERSION,
        submitter_hash: 'a'.repeat(64),
      });
      // Present before the run, so the assertion below can't pass merely
      // because the column was never written in the first place.
      const before = await testDb.db.prepare(`SELECT submitter_hash FROM scores WHERE id = ?`).bind(id).first<{ submitter_hash: string | null }>();
      expect(before!.submitter_hash).toBe('a'.repeat(64));

      await runAudit(baseOptions(testDb.db));

      const row = await testDb.db.prepare(`SELECT status, submitter_hash FROM scores WHERE id = ?`).bind(id).first<{ status: string; submitter_hash: string | null }>();
      expect(row).toEqual({ status: 'verified', submitter_hash: null });
    });

    // The pending fetch is season-agnostic on
    // purpose (an old season's leftovers have no other sweeper), but the
    // verdict layer used to compare only the ruleset/replay-format versions.
    // Bumping CURRENT_SEASON_ID while keeping RULESET_VERSION — season.ts's
    // documented "reset the ranking" operation — therefore let last season's
    // pending rows get CONFIRMED as verified: invisible to every ranking
    // query (which filters on season_id AND ruleset_version together) and
    // never trimmed by the TOP10 cleanup (current season only), so their
    // replay BLOBs piled up in the old season with no bound at all.
    it("deletes an old season's leftover pending row after a season bump, rather than verifying it, even though its ruleset_version is still current", async () => {
      const seed = 9500;
      const fixture = recordRealReplay(seed);
      const seedRow = (): Promise<string> =>
        seedScoreRow(testDb.db, {
          status: 'pending',
          season_id: SEASON_ID, // stored during the season that is about to be bumped away from
          seed,
          inputs: fixture.rle,
          score: fixture.score,
          stage: fixture.stage,
          duration_ticks: fixture.durationTicks,
          ruleset_version: RULESET_VERSION, // deliberately still CURRENT: the version checks alone cannot catch this row
          replay_format_version: REPLAY_FORMAT_VERSION,
        });

      const staleId = await seedRow();
      const events: AuditEvent[] = [];
      const bumped = await runAudit(baseOptions(testDb.db, { seasonId: SEASON_ID + 1, onEvent: (e) => events.push(e) }));
      expect(await statusOf(staleId)).toBeNull(); // swept, not left pending forever
      expect(bumped.verifiedCount).toBe(0); // and NOT confirmed into the dead season
      expect(bumped.deletedConfirmedInvalidCount).toBe(1);
      expect(events).toContainEqual({ type: 'entry-deleted-confirmed-invalid', id: staleId, reason: 'season-mismatch' });

      // Control: the very same row IS confirmed when the audit runs for the
      // season it actually belongs to — proving the deletion above came from
      // the season check and not from anything else about this fixture.
      const currentId = await seedRow();
      const sameSeason = await runAudit(baseOptions(testDb.db, { seasonId: SEASON_ID }));
      expect(sameSeason.verifiedCount).toBe(1);
      expect(await statusOf(currentId)).toBe('verified');
    });

    it('deletes a pending row with malformed RLE data (verifyReplay malformed-replay -> confirmed invalid)', async () => {
      const id = await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) });
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.deletedConfirmedInvalidCount).toBeGreaterThanOrEqual(1);
      expect(await statusOf(id)).toBeNull();
    });

    it('reproduces the forged-score scenario: a pending row whose declared score does not match the real resimulation is deleted (the async-audit equivalent of "偽スコア削除")', async () => {
      const seed = 9002;
      const fixture = recordRealReplay(seed);
      const id = await seedScoreRow(testDb.db, {
        status: 'pending',
        seed,
        inputs: fixture.rle,
        score: fixture.score + 999999, // forged claim, far beyond what this replay actually earned
        stage: fixture.stage,
        duration_ticks: fixture.durationTicks,
      });
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.deletedConfirmedInvalidCount).toBeGreaterThanOrEqual(1);
      expect(await statusOf(id)).toBeNull();
    });

    it('deletes a pending row whose declared ruleset_version no longer matches the server\'s current value', async () => {
      const id = await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([0, 1]), ruleset_version: RULESET_VERSION - 1 });
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.deletedConfirmedInvalidCount).toBeGreaterThanOrEqual(1);
      expect(await statusOf(id)).toBeNull();
    });
  });

  describe('unexpected-exception retry path', () => {
    it('increments audit_attempts and sets a future next_attempt_at on the first unexpected error, WITHOUT deleting the row', async () => {
      const id = await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([0, 1]), audit_attempts: 0, next_attempt_at: null });
      const verifyPendingEntryModule = await import('../../functions/_lib/ranking/verifyPendingEntry');
      vi.spyOn(verifyPendingEntryModule, 'verifyPendingEntry').mockImplementation(() => {
        throw new Error('simulated unexpected runtime error');
      });
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.retriedCount).toBeGreaterThanOrEqual(1);
      const row = await testDb.db.prepare(`SELECT status, audit_attempts, next_attempt_at FROM scores WHERE id = ?`).bind(id).first<{
        status: string;
        audit_attempts: number;
        next_attempt_at: number;
      }>();
      expect(row!.status).toBe('pending');
      expect(row!.audit_attempts).toBe(1);
      expect(row!.next_attempt_at).toBeGreaterThan(result.runStartedAt!);
      await testDb.db.prepare(`DELETE FROM scores WHERE id = ?`).bind(id).run();
    });

    it('a row with next_attempt_at in the future is NOT re-fetched within the same run (same-run re-acquisition is structurally impossible)', async () => {
      const farFuture = Math.floor(Date.now() / 1000) + 10_000;
      const id = await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([0, 1]), audit_attempts: 1, next_attempt_at: farFuture });
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.processedCount).toBe(0);
      expect(await statusOf(id)).toBe('pending');
      await testDb.db.prepare(`DELETE FROM scores WHERE id = ?`).bind(id).run();
    });

    it('deletes the row once it reaches maxAttempts unexpected-error attempts', async () => {
      const id = await seedScoreRow(testDb.db, {
        status: 'pending',
        inputs: new Uint8Array([0, 1]),
        audit_attempts: 2, // one more failure reaches maxAttempts (3)
        next_attempt_at: null,
      });
      const verifyPendingEntryModule = await import('../../functions/_lib/ranking/verifyPendingEntry');
      vi.spyOn(verifyPendingEntryModule, 'verifyPendingEntry').mockImplementation(() => {
        throw new Error('simulated unexpected runtime error');
      });
      const result = await runAudit(baseOptions(testDb.db, { maxAttempts: 3 }));
      expect(result.deletedAttemptsExhaustedCount).toBeGreaterThanOrEqual(1);
      expect(await statusOf(id)).toBeNull();
    });
  });

  describe('TOP10 cleanup (verified-scoped, pending-protected, rank_seq-invariant)', () => {
    it('trims verified rows down to the TOP10 for (season, ruleset) without touching rank_seq, and never deletes a pending row even if it is out of range', async () => {
      // 12 distinct, genuinely-valid verified replays (already verified —
      // seeded directly as such, since this describe block is about the
      // cleanup step specifically, not re-proving the confirm path above).
      const verifiedIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const seed = 9100 + i;
        const fixture = recordRealReplay(seed);
        const id = await seedScoreRow(testDb.db, {
          status: 'verified',
          seed,
          inputs: fixture.rle,
          score: 1000 + i, // strictly increasing -> a fully-determined ranking
          stage: fixture.stage,
          duration_ticks: fixture.durationTicks,
        });
        verifiedIds.push(id);
      }
      // A pending row that (by score alone) would rank inside the top 10 —
      // must survive the cleanup step untouched; only 'verified' rows are
      // ever a cleanup candidate. next_attempt_at is set far in the future
      // so this SAME run's own verification chunk-loop skips it entirely
      // (it would otherwise legitimately get resimulated and rejected for
      // never reaching gameover on a 1-sample replay, which would test the
      // verification step, not the cleanup step this test is about).
      const farFuture = Math.floor(Date.now() / 1000) + 10_000;
      const outrankingPendingId = await seedScoreRow(testDb.db, {
        status: 'pending',
        inputs: new Uint8Array([0, 1]),
        score: 999999,
        next_attempt_at: farFuture,
      });

      const rankSeqBefore = await testDb.db
        .prepare(`SELECT id, rank_seq FROM scores WHERE id IN (${verifiedIds.map(() => '?').join(',')})`)
        .bind(...verifiedIds)
        .all<{ id: string; rank_seq: number }>();
      const rankSeqById = new Map(rankSeqBefore.results.map((r) => [r.id, r.rank_seq]));

      const result = await runAudit(baseOptions(testDb.db));
      expect(result.top10CleanedCount).toBeGreaterThanOrEqual(2); // 12 verified -> only 10 survive

      const remaining = await testDb.db
        .prepare(`SELECT id, rank_seq FROM scores WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2`)
        .bind(SEASON_ID, RULESET_VERSION)
        .all<{ id: string; rank_seq: number }>();
      expect(remaining.results.length).toBeLessThanOrEqual(10);
      // The two lowest-scoring of the 12 are the ones trimmed; rank_seq is
      // never rewritten for whichever rows DO survive.
      for (const row of remaining.results) {
        expect(row.rank_seq).toBe(rankSeqById.get(row.id));
      }

      expect(await statusOf(outrankingPendingId)).toBe('pending'); // untouched by the verified-only cleanup
      await testDb.db.prepare(`DELETE FROM scores WHERE id = ?`).bind(outrankingPendingId).run();
    });
  });

  describe('chunked processing', () => {
    it('drains more pending rows than a single chunk in ONE run (chunking loops until pending is exhausted)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        ids.push(await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) })); // malformed -> cheap, deterministic deletion
      }
      const result = await runAudit(baseOptions(testDb.db, { chunkSize: 2 })); // 4 fetches: 2+2+2+1
      expect(result.processedCount).toBeGreaterThanOrEqual(7);
      expect(result.deletedConfirmedInvalidCount).toBeGreaterThanOrEqual(7);
      for (const id of ids) expect(await statusOf(id)).toBeNull();
    });

    it('stops at the (soft) time limit and leaves remaining pending rows for the next run', async () => {
      const ids = [await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }), await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) })];
      // -1: guarantees `Date.now() - wallClockStart > maxRuntimeMs` is true
      // on the very first check, deterministically, without any real sleep.
      const cutShort = await runAudit(baseOptions(testDb.db, { maxRuntimeMs: -1 }));
      expect(cutShort.reachedTimeLimit).toBe(true);
      expect(cutShort.processedCount).toBe(0);
      for (const id of ids) expect(await statusOf(id)).toBe('pending');

      // A normal follow-up run picks up exactly what was left behind.
      const followUp = await runAudit(baseOptions(testDb.db));
      expect(followUp.processedCount).toBeGreaterThanOrEqual(2);
      for (const id of ids) expect(await statusOf(id)).toBeNull();
    });

    it('processes a 200-row-regime pending backlog in ONE run at the real default chunk size (50/chunk)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 205; i++) {
        ids.push(await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) })); // malformed -> cheap, deterministic deletion
      }
      // No chunkSize override here — exercises the REAL AUDIT_CHUNK_SIZE (50)
      // default across 5 fetches (50+50+50+50+5) within a single run.
      const result = await runAudit(baseOptions(testDb.db));
      expect(result.reachedTimeLimit).toBe(false); // finished well within the (default, generous) time budget
      expect(result.processedCount).toBe(205);
      expect(result.deletedConfirmedInvalidCount).toBe(205);
      for (const id of ids) expect(await statusOf(id)).toBeNull();
      expect(await pendingCount()).toBe(0);
    }, 30_000);
  });

  describe('lease lost mid-run (lease-safety case)', () => {
    // The bug: every per-row audit write is fenced (LOCK_FENCE_SQL_FRAGMENT)
    // so it silently becomes a no-op once this run's lease is gone, but the
    // ORIGINAL runAudit() never inspected `meta.changes` at all — it
    // unconditionally counted every write as a success and kept looping.
    // A lease lost between one chunk's heartbeat (renewLock()) and its own
    // per-row writes therefore let a dispossessed run "complete
    // successfully" while quietly mutating nothing, never setting
    // `leaseLostMidRun`. Reproduced here via the REAL runAudit() code path
    // against real D1 (not just lock.ts's own primitives, which already
    // covered the fencing mechanism itself in lock.test.ts) by wrapping the
    // database so a rival owner silently steals the lock — exactly as
    // acquireLock() itself would once locked_until had genuinely lapsed —
    // right before one particular row's own write executes.
    const RIVAL_TOKEN = 'rival-owner-token';

    /**
     * Simulates: the run's lease genuinely lapsed in real wall-clock time and
     * a rival audit invocation's OWN acquireLock() legitimately took over —
     * issued as exactly the conditional UPDATE acquireLock() itself issues.
     */
    async function stealLockAsRival(realDb: D1Database): Promise<void> {
      await realDb.prepare(`UPDATE audit_lock SET locked_until = unixepoch() - 1 WHERE id = 1`).run();
      await realDb.prepare(`UPDATE audit_lock SET owner_token = '${RIVAL_TOKEN}', locked_until = unixepoch() + 600 WHERE id = 1 AND locked_until < unixepoch()`).run();
    }

    /** Gives the rival's hold back, so tests running after this one can acquire normally. */
    async function releaseRivalHold(): Promise<void> {
      await testDb.db.prepare(`UPDATE audit_lock SET owner_token = NULL, locked_until = unixepoch() - 1 WHERE id = 1`).run();
    }

    // Unconditionally, even (especially) when a test above FAILED partway:
    // a rival hold left behind would make every later test in this file fail
    // to acquire the lock, burying the one real failure under a cascade of
    // unrelated ones.
    afterEach(releaseRivalHold);

    /**
     * Wraps a D1Database so `stealLockAsRival()` fires immediately before the
     * first `.run()` of a statement whose SQL matches `stealBeforeSql` —
     * i.e. the theft lands in the window between that write's own last
     * ownership check and its execution, which is the only window the write's
     * fencing (and nothing else) is supposed to cover.
     */
    function wrapDbForTheftBefore(realDb: D1Database, stealBeforeSql: (sql: string) => boolean): { db: AuditD1Database; stolen: () => boolean } {
      let stolen = false;
      const wrapped = {
        prepare(sql: string) {
          if (!stealBeforeSql(sql)) return realDb.prepare(sql);
          return {
            bind(...args: AuditD1BindValue[]) {
              const bound = realDb.prepare(sql).bind(...args);
              return {
                ...bound,
                run: async () => {
                  if (!stolen) {
                    stolen = true;
                    await stealLockAsRival(realDb);
                  }
                  return bound.run();
                },
              };
            },
          };
        },
      } as AuditD1Database;
      return { db: wrapped, stolen: () => stolen };
    }

    function wrapDbForLeaseTheft(realDb: D1Database, stealAfterNRowWrites: number): { db: AuditD1Database; rowWriteCount: () => number } {
      let rowWriteCount = 0;
      let stolen = false;
      const wrapped = {
        prepare(sql: string) {
          const isRowWrite = sql.includes('WHERE rank_seq =') && sql.includes('audit_lock');
          if (!isRowWrite) return realDb.prepare(sql);
          return {
            bind(...args: AuditD1BindValue[]) {
              const bound = realDb.prepare(sql).bind(...args);
              return {
                ...bound,
                run: async () => {
                  rowWriteCount++;
                  if (!stolen && rowWriteCount > stealAfterNRowWrites) {
                    stolen = true;
                    await stealLockAsRival(realDb);
                  }
                  return bound.run();
                },
              };
            },
          };
        },
      } as AuditD1Database;
      return { db: wrapped, rowWriteCount: () => rowWriteCount };
    }

    it('stops the run (leaseLostMidRun=true) and leaves later rows/DB state untouched once a rival owner steals the lock mid-chunk', async () => {
      const ids = [
        await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }),
        await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }),
        await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }),
      ];
      // stealAfterNRowWrites=1: row #1's own write completes normally
      // (proving the theft doesn't fire prematurely); the theft fires
      // immediately before row #2's write, which must then observe
      // fencing failure.
      const { db: theftDb, rowWriteCount } = wrapDbForLeaseTheft(testDb.db, 1);

      const result = await runAudit(baseOptions(theftDb, { chunkSize: 10 })); // all 3 rows fetched in one chunk, so the theft happens WITHIN a chunk, not caught by the next chunk's own renewLock() heartbeat
      expect(result.leaseLostMidRun).toBe(true);
      expect(rowWriteCount()).toBeGreaterThanOrEqual(2); // proves row #2's write was actually attempted (and observed as fenced-out), not skipped outright

      // Row #1 (processed before the theft) really was deleted...
      expect(await statusOf(ids[0])).toBeNull();
      expect(result.deletedConfirmedInvalidCount).toBe(1);
      // ...but rows #2 and #3 (after the theft) are COMPLETELY untouched —
      // the fenced write for #2 was a genuine no-op, and #3 was never even
      // attempted (the run broke out of the loop immediately).
      expect(await statusOf(ids[1])).toBe('pending');
      expect(await statusOf(ids[2])).toBe('pending');
      const untouchedRow = await testDb.db.prepare(`SELECT audit_attempts, next_attempt_at FROM scores WHERE id = ?`).bind(ids[1]).first<{ audit_attempts: number; next_attempt_at: number | null }>();
      expect(untouchedRow).toEqual({ audit_attempts: 0, next_attempt_at: null });

      // The rival really does hold the lock now — this run's own release
      // (its `finally` block) must NOT have clobbered it (it too is fenced,
      // via releaseLock()'s own owner+unexpired condition).
      const lockRow = await testDb.db.prepare(`SELECT owner_token FROM audit_lock WHERE id = 1`).first<{ owner_token: string }>();
      expect(lockRow!.owner_token).toBe('rival-owner-token');

      // TOP10 cleanup must have been skipped entirely once lease loss was
      // detected; no further writes are allowed for that chunk.
      expect(result.top10CleanedCount).toBe(0);
    });

    it('a subsequent, legitimate run can still make progress on the rows the dispossessed run left behind', async () => {
      const ids = [
        await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }),
        await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }),
      ];
      const { db: theftDb } = wrapDbForLeaseTheft(testDb.db, 0); // steal before the very first row's write
      const dispossessed = await runAudit(baseOptions(theftDb, { chunkSize: 10 }));
      expect(dispossessed.leaseLostMidRun).toBe(true);
      expect(dispossessed.processedCount).toBeGreaterThanOrEqual(1);
      expect(dispossessed.deletedConfirmedInvalidCount).toBe(0); // nothing actually got written
      for (const id of ids) expect(await statusOf(id)).toBe('pending');

      // Release the rival, then run for real.
      await releaseRivalHold();
      const followUp = await runAudit(baseOptions(testDb.db));
      expect(followUp.leaseLostMidRun).toBe(false);
      expect(followUp.lockReleased).toBe(true);
      expect(followUp.deletedConfirmedInvalidCount).toBe(2);
      for (const id of ids) expect(await statusOf(id)).toBeNull();
    });

    // The second lease-safety case: the per-row writes
    // above were fixed to check `meta.changes`, but the TOP10-cleanup DELETE
    // — the one remaining fenced write — still read its `meta.changes` raw.
    // A lease stolen after the final chunk but before that DELETE therefore
    // fenced it into a silent no-op that was indistinguishable from the
    // ordinary "nothing to trim" case: the run reported top10CleanedCount=0,
    // leaseLostMidRun=false and finished "successfully", while out-of-TOP10
    // verified rows stayed in the table and the failed releaseLock() (the
    // lock being the rival's by then) went unreported entirely.
    describe('lease stolen after the final chunk, before TOP10 cleanup', () => {
      /** 12 verified rows (strictly increasing scores) — 2 of them out of the TOP10, i.e. real cleanup work. */
      async function seedTwelveVerified(): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) {
          // `inputs` is irrelevant here: 'verified' rows are never re-verified
          // by a run, only ranked/trimmed — so no replay fixture is needed.
          ids.push(await seedScoreRow(testDb.db, { status: 'verified', score: 1000 + i }));
        }
        return ids;
      }

      async function verifiedIdsInDb(): Promise<string[]> {
        const rows = await testDb.db
          .prepare(`SELECT id FROM scores WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2 ORDER BY id`)
          .bind(SEASON_ID, RULESET_VERSION)
          .all<{ id: string }>();
        return rows.results.map((r) => r.id);
      }

      it('leaves the out-of-TOP10 verified rows to the new owner, reports leaseLostMidRun=true, and reports the failed release', async () => {
        const verifiedIds = await seedTwelveVerified();
        // Two malformed pending rows: the chunk loop processes and deletes
        // them normally FIRST, so the theft provably lands after the final
        // chunk (not during one) — the exact window the per-row fix left open.
        const pendingIds = [await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) }), await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]) })];

        const events: string[] = [];
        const { db: theftDb, stolen } = wrapDbForTheftBefore(testDb.db, (sql) => sql.includes('rank_seq NOT IN'));
        const result = await runAudit(baseOptions(theftDb, { onEvent: (e) => events.push(e.type) }));

        expect(stolen()).toBe(true); // the cleanup DELETE really was reached (and the theft really did fire right before it)
        // The final chunk completed normally before the theft.
        expect(result.deletedConfirmedInvalidCount).toBe(2);
        for (const id of pendingIds) expect(await statusOf(id)).toBeNull();

        // 1. The cleanup DELETE was a no-op: ALL 12 verified rows survive,
        // including the 2 out-of-TOP10 ones — they are the new owner's to
        // trim now, not this dispossessed run's.
        expect(await verifiedIdsInDb()).toEqual([...verifiedIds].sort());
        expect(result.top10CleanedCount).toBe(0);

        // 2. ...and that no-op is reported as lease loss, not as a completed run.
        expect(result.leaseLostMidRun).toBe(true);
        expect(events).toContain('lease-lost-before-top10-cleanup');
        expect(events).not.toContain('top10-cleanup');

        // 3. releaseLock() could not release a lock that was no longer ours,
        // and that shows up in the result (and the log), not just silently.
        expect(result.lockReleased).toBe(false);
        expect(await testDb.db.prepare(`SELECT owner_token FROM audit_lock WHERE id = 1`).first<{ owner_token: string }>()).toEqual({ owner_token: RIVAL_TOKEN });
      });

      it('reports a lease lost even in the last possible window — after the cleanup, at release time itself', async () => {
        const verifiedIds = await seedTwelveVerified();
        const events: string[] = [];
        // Steal right before releaseLock()'s own UPDATE: every piece of audit
        // work, TOP10 cleanup included, has already succeeded at this point,
        // so the ONLY signal that this run did not end cleanly is
        // releaseLock()'s false return.
        const { db: theftDb, stolen } = wrapDbForTheftBefore(testDb.db, (sql) => sql.includes('SET owner_token = NULL'));
        const result = await runAudit(baseOptions(theftDb, { onEvent: (e) => events.push(e.type) }));

        expect(stolen()).toBe(true);
        // The cleanup itself ran normally, before the theft: the 2
        // lowest-scoring of the 12 verified rows are gone, 10 survive.
        expect(result.top10CleanedCount).toBe(2);
        expect(await verifiedIdsInDb()).toEqual(verifiedIds.slice(2).sort());

        expect(result.lockReleased).toBe(false);
        expect(result.leaseLostMidRun).toBe(true); // NOT reported as a clean run
        expect(events).toContain('lease-lost-at-release');
      });
    });
  });

  // Public-log hygiene: this repository is public, so the audit
  // workflow's GitHub Actions run log — which is just these events, printed
  // verbatim as JSON by scripts/audit/cli.ts — is world-readable. These tests
  // pin down what may appear in it, against a REAL run rather than by reading
  // the event type.
  describe('public-log hygiene (events are published output)', () => {
    /**
     * The complete set of fields each event kind may carry.
     *
     * The mapped type over `AuditEvent['type']` is the point: a new event kind
     * added to the union makes THIS OBJECT fail to compile (`npm run
     * typecheck` covers scripts/**\/*.ts, this file included), so a kind can
     * never reach the published log without being listed here and justified
     * against docs/ranking-audit-runbook.md §5's log policy. The earlier
     * `Record<string, ...>` version
     * silently accepted new kinds and left the ones no test happens to
     * trigger (lease-lost-*, time-limit-reached, attempts-exhausted)
     * unchecked entirely.
     */
    const ALLOWED_EVENT_FIELDS: { [K in AuditEvent['type']]: readonly string[] } = {
      'lock-not-acquired': [],
      'lock-acquired': ['runStartedAt'],
      'expired-pending-deleted': ['count'],
      'chunk-fetched': ['count'],
      'entry-verified': ['id'],
      'entry-deleted-confirmed-invalid': ['id', 'reason'],
      'entry-retry-scheduled': ['id', 'attempts', 'errorName', 'errorDetail'],
      'entry-deleted-attempts-exhausted': ['id', 'attempts', 'errorName', 'errorDetail'],
      'lease-lost-mid-chunk': [],
      'time-limit-reached': [],
      'lease-lost-before-top10-cleanup': [],
      'top10-cleanup': ['deletedCount'],
      'lease-lost-at-release': [],
      'lock-released': ['released'],
    };

    /**
     * One fully-populated instance of EVERY event kind, again mapped over the
     * union so a new kind fails to compile until it has a fixture here.
     *
     * `Required<...>` is the second half of that guarantee: a plain
     * `Extract<...>` keeps optional
     * fields optional, so an event could gain an `owner_token?: string`,
     * actually emit it at runtime, and still typecheck against a fixture that
     * omits it — the field would reach the public log completely unexamined.
     * With Required, every field a kind CAN carry (`errorDetail` included) has
     * to be present in its fixture, so the checks below always see the widest
     * shape — which matters most for the kinds a real run can't easily reach
     * (lease-lost-*, time-limit-reached, attempts-exhausted).
     */
    const EVENT_FIXTURES: { [K in AuditEvent['type']]: Required<Extract<AuditEvent, { type: K }>> } = {
      'lock-not-acquired': { type: 'lock-not-acquired' },
      'lock-acquired': { type: 'lock-acquired', runStartedAt: 1787187884 },
      'expired-pending-deleted': { type: 'expired-pending-deleted', count: 3 },
      'chunk-fetched': { type: 'chunk-fetched', count: 50 },
      'entry-verified': { type: 'entry-verified', id: 'kX7pQ2mB' },
      'entry-deleted-confirmed-invalid': { type: 'entry-deleted-confirmed-invalid', id: 'kX7pQ2mB', reason: 'declared-score-mismatch' },
      'entry-retry-scheduled': { type: 'entry-retry-scheduled', id: 'kX7pQ2mB', attempts: 1, errorName: 'TypeError', errorDetail: 'a first line' },
      'entry-deleted-attempts-exhausted': { type: 'entry-deleted-attempts-exhausted', id: 'kX7pQ2mB', attempts: 3, errorName: 'TypeError', errorDetail: 'a first line' },
      'lease-lost-mid-chunk': { type: 'lease-lost-mid-chunk' },
      'time-limit-reached': { type: 'time-limit-reached' },
      'lease-lost-before-top10-cleanup': { type: 'lease-lost-before-top10-cleanup' },
      'top10-cleanup': { type: 'top10-cleanup', deletedCount: 2 },
      'lease-lost-at-release': { type: 'lease-lost-at-release' },
      'lock-released': { type: 'lock-released', released: true },
    };

    function assertOnlyAllowedFields(events: AuditEvent[]): void {
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const allowed = ALLOWED_EVENT_FIELDS[event.type];
        expect(allowed, `unknown event type '${event.type}' — add it to ALLOWED_EVENT_FIELDS and check it against the runbook's log policy`).toBeDefined();
        for (const key of Object.keys(event)) {
          if (key === 'type') continue;
          expect(allowed, `event '${event.type}' carries an unexpected field '${key}'`).toContain(key);
        }
      }
    }

    /** Field-level patterns that must never appear in a published log line, whatever the event kind. */
    function assertNoForbiddenContent(events: AuditEvent[], extraForbiddenStrings: readonly string[] = []): void {
      const printed = events.map((e) => JSON.stringify(e)).join('\n');
      expect(printed).not.toMatch(/[0-9a-f]{32}/); // owner_token / ip_hash / any other hash-shaped value
      expect(printed).not.toMatch(/\bat .*\.ts:\d+/); // stack frames
      expect(printed).not.toMatch(/\/(Users|home|root|var)\//); // absolute paths
      expect(printed).not.toMatch(/ip_hash|owner_token|RANKING_IP_HASH_KEY/i);
      for (const forbidden of extraForbiddenStrings) expect(printed).not.toContain(forbidden);
    }

    /** Captures the audit lock's owner_token as acquireLock() binds it, so the assertions below can look for the REAL secret, not a stand-in. */
    function wrapDbCapturingOwnerToken(realDb: D1Database): { db: AuditD1Database; ownerToken: () => string | null } {
      let token: string | null = null;
      const wrapped = {
        prepare(sql: string) {
          if (!sql.includes('UPDATE audit_lock') || !sql.includes('SET owner_token = ?1')) return realDb.prepare(sql);
          return {
            bind(...args: AuditD1BindValue[]) {
              if (typeof args[0] === 'string' && args[0] !== '') token = args[0];
              return realDb.prepare(sql).bind(...args);
            },
          };
        },
      } as AuditD1Database;
      return { db: wrapped, ownerToken: () => token };
    }

    const IP_HASH = 'ip-hash-8f3b1c2d4e5a6b7c8d9e0f1a2b3c4d5e';

    // The checks below run against REAL runs, which can only reach the event
    // kinds their scenario produces. This one covers the union exhaustively —
    // including the kinds no test can easily provoke — so every kind's widest
    // possible shape is inspected, not just the convenient ones.
    it('EVERY event kind (typed fixtures over the whole AuditEvent union) carries only allowlisted, publishable fields', () => {
      const fixtures = Object.values(EVENT_FIXTURES) as AuditEvent[];

      // The fixture table and the field table must both stay complete: the
      // mapped types make that a compile-time guarantee, and these two
      // assertions make a mismatch visible at runtime too (a stale key left
      // behind after a rename, say).
      expect(Object.keys(EVENT_FIXTURES).sort()).toEqual(Object.keys(ALLOWED_EVENT_FIELDS).sort());
      for (const [key, fixture] of Object.entries(EVENT_FIXTURES)) expect(fixture.type).toBe(key);

      // Each fixture must actually exercise every field its kind may carry —
      // otherwise "the fixture is clean" would say nothing about a field no
      // fixture populates.
      for (const fixture of fixtures) {
        const allowed = ALLOWED_EVENT_FIELDS[fixture.type];
        expect(Object.keys(fixture).filter((k) => k !== 'type').sort(), `fixture for '${fixture.type}' must populate every allowlisted field`).toEqual([...allowed].sort());
      }

      assertOnlyAllowedFields(fixtures);
      assertNoForbiddenContent(fixtures);
    });

    it('a run covering every ordinary outcome leaks no ip_hash, no owner_token and no raw error text', async () => {
      const seed = 9700;
      const fixture = recordRealReplay(seed);
      // One row per outcome the log can report: verified, confirmed-invalid,
      // and (via the 12 verified rows) a TOP10 cleanup.
      await seedScoreRow(testDb.db, {
        status: 'pending',
        seed,
        inputs: fixture.rle,
        score: fixture.score,
        stage: fixture.stage,
        duration_ticks: fixture.durationTicks,
        ip_hash: IP_HASH,
      });
      await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([255, 1]), ip_hash: IP_HASH });
      await seedScoreRow(testDb.db, { status: 'pending', created_at: Date.now() - 25 * HOUR_MS, ip_hash: IP_HASH });
      for (let i = 0; i < 12; i++) await seedScoreRow(testDb.db, { status: 'verified', score: 500 + i, ip_hash: IP_HASH });

      const events: AuditEvent[] = [];
      const { db: captureDb, ownerToken } = wrapDbCapturingOwnerToken(testDb.db);
      await runAudit(baseOptions(captureDb, { onEvent: (e) => events.push(e) }));

      // The run really did produce the interesting events, so the assertions
      // below are not vacuously true.
      const types = events.map((e) => e.type);
      expect(types).toContain('entry-verified');
      expect(types).toContain('entry-deleted-confirmed-invalid');
      expect(types).toContain('top10-cleanup');
      assertOnlyAllowedFields(events);

      // What the CLI would actually print, checked as text.
      expect(ownerToken()).toMatch(/^[0-9a-f]{32}$/); // the wrapper really did capture it
      assertNoForbiddenContent(events, [IP_HASH, ownerToken()!]);

      // The confirmed-invalid event reports the KIND of rejection only —
      // never the declared-vs-resimulated values behind it.
      const rejection = events.find((e) => e.type === 'entry-deleted-confirmed-invalid');
      expect(rejection).toEqual({ type: 'entry-deleted-confirmed-invalid', id: expect.any(String), reason: 'malformed-replay' });
    });

    it('the unexpected-exception retry path logs the error CLASS only — never its message or stack', async () => {
      await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([0, 1]), ip_hash: IP_HASH });
      const verifyPendingEntryModule = await import('../../functions/_lib/ranking/verifyPendingEntry');
      class D1ConnectionError extends Error {
        constructor() {
          super('connect ECONNREFUSED 10.1.2.3:5432 db=qixxx-scores token=abcdef0123456789abcdef0123456789\nsecond line of the message');
          this.name = 'D1ConnectionError';
        }
      }
      vi.spyOn(verifyPendingEntryModule, 'verifyPendingEntry').mockImplementation(() => {
        throw new D1ConnectionError();
      });

      const events: AuditEvent[] = [];
      await runAudit(baseOptions(testDb.db, { onEvent: (e) => events.push(e) }));

      const retry = events.find((e) => e.type === 'entry-retry-scheduled');
      // 'D1ConnectionError' is a plausible-looking but UNLISTED class name, so
      // it is reported as 'UnknownError' rather than echoed (logSafety.ts's
      // ALLOWED_ERROR_NAMES) — the class name itself is attacker-influenceable
      // in the general case.
      expect(retry).toEqual({ type: 'entry-retry-scheduled', id: expect.any(String), attempts: 1, errorName: 'UnknownError' });
      assertOnlyAllowedFields(events);
      assertNoForbiddenContent(events, ['ECONNREFUSED', '10.1.2.3', 'D1ConnectionError', 'second line of the message']);
    });

    it('an allowlisted error class IS named, so a retry stays diagnosable', async () => {
      await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([0, 1]) });
      const verifyPendingEntryModule = await import('../../functions/_lib/ranking/verifyPendingEntry');
      vi.spyOn(verifyPendingEntryModule, 'verifyPendingEntry').mockImplementation(() => {
        throw new TypeError('cannot read properties of undefined (reading "x")');
      });

      const events: AuditEvent[] = [];
      await runAudit(baseOptions(testDb.db, { onEvent: (e) => events.push(e) }));

      expect(events.find((e) => e.type === 'entry-retry-scheduled')).toEqual({ type: 'entry-retry-scheduled', id: expect.any(String), attempts: 1, errorName: 'TypeError' });
      assertOnlyAllowedFields(events);
      assertNoForbiddenContent(events, ['cannot read properties']);
    });

    it('opting into error detail (local debugging only) adds the first message line, still without the stack', async () => {
      await seedScoreRow(testDb.db, { status: 'pending', inputs: new Uint8Array([0, 1]) });
      const verifyPendingEntryModule = await import('../../functions/_lib/ranking/verifyPendingEntry');
      vi.spyOn(verifyPendingEntryModule, 'verifyPendingEntry').mockImplementation(() => {
        throw new Error('first line only\nsecond line, dropped');
      });

      const events: AuditEvent[] = [];
      await runAudit(baseOptions(testDb.db, { includeErrorDetail: true, onEvent: (e) => events.push(e) }));

      const retry = events.find((e) => e.type === 'entry-retry-scheduled');
      expect(retry).toEqual({ type: 'entry-retry-scheduled', id: expect.any(String), attempts: 1, errorName: 'Error', errorDetail: 'first line only' });
      assertOnlyAllowedFields(events);
      expect(JSON.stringify(events)).not.toContain('second line, dropped');
    });
  });

  it('two concurrent runAudit() calls against the same D1: exactly one acquires the lock', async () => {
    const [a, b] = await Promise.all([runAudit(baseOptions(testDb.db)), runAudit(baseOptions(testDb.db))]);
    const acquiredCount = [a, b].filter((r) => r.acquired).length;
    expect(acquiredCount).toBe(1);
  });
});
