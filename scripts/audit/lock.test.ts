// Real-D1 integration tests for audit_lock's owner-identity + fencing
// (docs/plans/2026-08-19-ranking-free-async spec item 9). Runs against an
// actual local D1 database (scripts/audit/testSupport/localD1.ts), not a
// hand-rolled mock — the whole point of this design is atomic conditional
// UPDATEs, which only a real SQLite engine's transaction semantics can
// genuinely confirm.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from './testSupport/localD1';
import { acquireLock, renewLock, releaseLock, LOCK_FENCE_SQL_FRAGMENT } from './lock';

describe('audit_lock (real local D1)', () => {
  let testDb: TestD1;

  beforeAll(async () => {
    testDb = await createTestD1();
  }, 30_000);

  afterAll(async () => {
    await testDb.dispose();
  });

  beforeEach(async () => {
    // Reset to the migration's own initial-row shape before every test, so
    // each test starts from "unlocked, never yet acquired" regardless of
    // what a previous test left behind.
    await testDb.db.prepare(`UPDATE audit_lock SET owner_token = '', locked_until = 0 WHERE id = 1`).run();
  });

  it('a fresh (never-yet-acquired) database allows the first acquire to succeed immediately', async () => {
    const lock = await acquireLock(testDb.db);
    expect(lock).not.toBeNull();
    expect(typeof lock!.ownerToken).toBe('string');
    expect(lock!.ownerToken.length).toBeGreaterThan(0);
  });

  it('runStartedAt is the D1-side unixepoch() clock, not a value the caller invented — sane and close to real time', async () => {
    const before = Math.floor(Date.now() / 1000);
    const lock = await acquireLock(testDb.db);
    const after = Math.floor(Date.now() / 1000);
    expect(lock!.runStartedAt).toBeGreaterThanOrEqual(before - 2);
    expect(lock!.runStartedAt).toBeLessThanOrEqual(after + 2);
  });

  it('a second acquire attempt fails (returns null) while the first lease is still unexpired', async () => {
    const first = await acquireLock(testDb.db);
    expect(first).not.toBeNull();
    const second = await acquireLock(testDb.db);
    expect(second).toBeNull();
  });

  it('acquire succeeds again once the previous lease has expired', async () => {
    const first = await acquireLock(testDb.db);
    expect(first).not.toBeNull();
    // Simulate lease expiry directly (rather than waiting 10 real minutes).
    await testDb.db.prepare(`UPDATE audit_lock SET locked_until = unixepoch() - 1 WHERE id = 1`).run();
    const second = await acquireLock(testDb.db);
    expect(second).not.toBeNull();
    expect(second!.ownerToken).not.toBe(first!.ownerToken);
  });

  it('renewLock succeeds for the current, unexpired owner', async () => {
    const lock = await acquireLock(testDb.db);
    const renewed = await renewLock(testDb.db, lock!.ownerToken);
    expect(renewed).toBe(true);
  });

  it('renewLock fails for a token that never held the lock', async () => {
    await acquireLock(testDb.db);
    const renewed = await renewLock(testDb.db, 'not-the-real-owner-token');
    expect(renewed).toBe(false);
  });

  it('renewLock fails once the lease has already expired, even for the true former owner (fencing, not merely identity)', async () => {
    const lock = await acquireLock(testDb.db);
    await testDb.db.prepare(`UPDATE audit_lock SET locked_until = unixepoch() - 1 WHERE id = 1`).run();
    const renewed = await renewLock(testDb.db, lock!.ownerToken);
    expect(renewed).toBe(false);
  });

  it('releaseLock succeeds for the current unexpired owner, and immediately frees the lock for a new acquire', async () => {
    const lock = await acquireLock(testDb.db);
    const released = await releaseLock(testDb.db, lock!.ownerToken);
    expect(released).toBe(true);
    const next = await acquireLock(testDb.db);
    expect(next).not.toBeNull();
  });

  it('releaseLock is a no-op (false) once the lease has already expired', async () => {
    const lock = await acquireLock(testDb.db);
    await testDb.db.prepare(`UPDATE audit_lock SET locked_until = unixepoch() - 1 WHERE id = 1`).run();
    const released = await releaseLock(testDb.db, lock!.ownerToken);
    expect(released).toBe(false);
  });

  it('renewLock is a no-op for a DIFFERENT, still-live owner (two-run overlap never lets the second run extend the first\'s lease)', async () => {
    const first = await acquireLock(testDb.db);
    expect(first).not.toBeNull();
    // A concurrent second run attempting to acquire fails (already covered
    // above); what matters here is that even if it somehow learned some
    // OTHER token, it can never renew/release using it.
    const renewed = await renewLock(testDb.db, 'some-other-runs-token');
    const released = await releaseLock(testDb.db, 'some-other-runs-token');
    expect(renewed).toBe(false);
    expect(released).toBe(false);
    // And the real owner's lease is untouched by those no-ops.
    expect(await renewLock(testDb.db, first!.ownerToken)).toBe(true);
  });

  describe('LOCK_FENCE_SQL_FRAGMENT (write-statement-level fencing)', () => {
    it('EXISTS(...) is true for the current owner while the lease is live', async () => {
      const lock = await acquireLock(testDb.db);
      const row = await testDb.db.prepare(`SELECT ${LOCK_FENCE_SQL_FRAGMENT} AS fenced`).bind(lock!.ownerToken).first<{ fenced: number }>();
      expect(row!.fenced).toBe(1);
    });

    it('EXISTS(...) is false once the lease has expired, even for the true owner — a write using this fragment becomes a no-op', async () => {
      const lock = await acquireLock(testDb.db);
      await testDb.db.prepare(`UPDATE audit_lock SET locked_until = unixepoch() - 1 WHERE id = 1`).run();
      const row = await testDb.db.prepare(`SELECT ${LOCK_FENCE_SQL_FRAGMENT} AS fenced`).bind(lock!.ownerToken).first<{ fenced: number }>();
      expect(row!.fenced).toBe(0);
    });

    it('EXISTS(...) is false for a token that is simply not the current owner', async () => {
      await acquireLock(testDb.db);
      const row = await testDb.db.prepare(`SELECT ${LOCK_FENCE_SQL_FRAGMENT} AS fenced`).bind('wrong-token').first<{ fenced: number }>();
      expect(row!.fenced).toBe(0);
    });
  });
});
