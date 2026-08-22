// The audit job's mutex, based on owner identity and write fencing.
// `audit_lock` is a single
// row (id=1, created by migrations/0002_ranking_free_async.sql, initial row
// included) acting as a mutex across concurrent/overlapping audit runs.
//
// Every time value here is D1/SQLite's own `unixepoch()` (seconds), never
// the Node process's `Date.now()`. Preventing same-run reacquisition depends
// specifically on `runStartedAt` using the SAME clock the
// pending-fetch query's `next_attempt_at` comparison runs against, so a
// Node/D1 clock skew can never open a gap between them.
export const LOCK_LEASE_SECONDS = 10 * 60; // 10 minutes, longer than the five-minute maximum runtime

function randomOwnerToken(): string {
  // 16 random bytes, hex-encoded — collision-negligible, and always a
  // non-empty string so it can never accidentally equal the initial row's
  // owner_token='' sentinel (migrations/0002_ranking_free_async.sql).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AcquiredLock {
  ownerToken: string;
  /** D1-side unixepoch() seconds at the moment this lock was acquired. */
  runStartedAt: number;
}

/**
 * Attempts to acquire the audit lock:
 * `UPDATE audit_lock SET owner_token=<random>, locked_until=now+10min WHERE
 * id=1 AND locked_until < now`. Returns null (not an error) if another run
 * currently holds an unexpired lease — that is the expected, ordinary
 * outcome of a concurrent/overlapping invocation, not a failure.
 */
export async function acquireLock(db: D1Database): Promise<AcquiredLock | null> {
  const ownerToken = randomOwnerToken();
  const row = await db
    .prepare(
      `UPDATE audit_lock
       SET owner_token = ?1, locked_until = unixepoch() + ?2
       WHERE id = 1 AND locked_until < unixepoch()
       RETURNING unixepoch() AS run_started_at`
    )
    .bind(ownerToken, LOCK_LEASE_SECONDS)
    .first<{ run_started_at: number }>();
  if (!row) return null;
  return { ownerToken, runStartedAt: row.run_started_at };
}

/**
 * Renews the lease as a heartbeat, called once
 * per pending-verification chunk. Returns true only if this call's
 * owner_token still matched an unexpired lease at the moment of the UPDATE
 * (`changes = 1`) — false means this run's lease is gone (lost to a lease
 * timeout, most likely, since ownership itself can only ever be taken over
 * by acquireLock() after `locked_until` has already passed), and the caller
 * MUST NOT issue any further writes for the in-progress chunk; processing
 * stops immediately.
 */
export async function renewLock(db: D1Database, ownerToken: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE audit_lock SET locked_until = unixepoch() + ?2 WHERE id = 1 AND owner_token = ?1 AND locked_until >= unixepoch()`)
    .bind(ownerToken, LOCK_LEASE_SECONDS)
    .run();
  return result.meta.changes === 1;
}

/**
 * Releases the lock using the same owner+unexpired condition
 * as renewLock(). A false return (lease already gone) is not an error: the
 * lock is effectively already free for the next acquirer either way, this
 * call just has nothing left to do.
 */
export async function releaseLock(db: D1Database, ownerToken: string): Promise<boolean> {
  // locked_until = unixepoch() - 1 (strictly in the past), not
  // `unixepoch()` itself: acquireLock()'s condition is `locked_until < now`,
  // and a release+immediate-reacquire happening within the same D1-clock
  // second would otherwise compare `now < now` — false — leaving the lock
  // spuriously un-acquirable for up to a second after a clean release.
  const result = await db
    .prepare(`UPDATE audit_lock SET owner_token = NULL, locked_until = unixepoch() - 1 WHERE id = 1 AND owner_token = ?1 AND locked_until >= unixepoch()`)
    .bind(ownerToken)
    .run();
  return result.meta.changes === 1;
}

/**
 * The SQL fragment every audit write statement must AND into its own WHERE
 * clause. This write-level fence is a
 * belt-and-braces check that this run's lease is STILL valid at the exact
 * moment each individual write actually executes, not just at the start of
 * the chunk that called renewLock(). Bind `ownerToken` at the SAME
 * positional slot every call site uses (see scripts/audit/runAudit.ts's own
 * call sites for the binding order each statement uses).
 */
export const LOCK_FENCE_SQL_FRAGMENT = `EXISTS (SELECT 1 FROM audit_lock WHERE id = 1 AND owner_token = ? AND locked_until >= unixepoch())`;
