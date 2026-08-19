// The async audit job itself (docs/plans/2026-08-19-ranking-free-async spec
// items 3/7/8/9/10) — pure orchestration over a plain D1Database (obtained
// via scripts/audit/d1Adapter.ts by the CLI entrypoint, or directly by
// integration tests). Verifies pending rows via functions/_lib/ranking/
// verifyPendingEntry() (which itself calls the UNCHANGED verifyReplay()),
// confirms or deletes them, retries genuinely-unexpected errors, sweeps
// expired pending rows, and trims verified rows back down to the TOP10 —
// all under the audit_lock mutex (scripts/audit/lock.ts), with every write
// statement fenced by LOCK_FENCE_SQL_FRAGMENT (spec item 9's "二重防御").
import { verifyPendingEntry } from '../../functions/_lib/ranking/verifyPendingEntry';
import type { BenchVerifyHooks } from '../../functions/_lib/ranking/benchHooks';
import { acquireLock, renewLock, releaseLock, LOCK_FENCE_SQL_FRAGMENT } from './lock';
import { AUDIT_CHUNK_SIZE, AUDIT_MAX_RUNTIME_MS, AUDIT_MAX_ATTEMPTS, AUDIT_RETRY_DELAY_SECONDS } from './constants';

export interface RunAuditOptions {
  db: D1Database;
  seasonId: number;
  rulesetVersion: number;
  replayFormatVersion: number;
  chunkSize?: number;
  maxRuntimeMs?: number;
  maxAttempts?: number;
  /** Test-only hook, mirroring verifyReplay()'s own — never set in a real audit run. */
  benchHooks?: BenchVerifyHooks;
  /** Progress/log callback — never required for correctness, purely observational (the CLI entrypoint wires this to console.log). */
  onEvent?: (event: AuditEvent) => void;
}

export type AuditEvent =
  | { type: 'lock-not-acquired' }
  | { type: 'lock-acquired'; runStartedAt: number }
  | { type: 'expired-pending-deleted'; count: number }
  | { type: 'chunk-fetched'; count: number }
  | { type: 'entry-verified'; id: string }
  | { type: 'entry-deleted-confirmed-invalid'; id: string; reason: string }
  | { type: 'entry-retry-scheduled'; id: string; attempts: number }
  | { type: 'entry-deleted-attempts-exhausted'; id: string; attempts: number }
  | { type: 'lease-lost-mid-chunk' }
  | { type: 'time-limit-reached' }
  | { type: 'top10-cleanup'; deletedCount: number }
  | { type: 'lock-released'; released: boolean };

export interface RunAuditResult {
  acquired: boolean;
  runStartedAt: number | null;
  expiredDeletedCount: number;
  processedCount: number;
  verifiedCount: number;
  deletedConfirmedInvalidCount: number;
  retriedCount: number;
  deletedAttemptsExhaustedCount: number;
  top10CleanedCount: number;
  reachedTimeLimit: boolean;
  leaseLostMidRun: boolean;
}

interface PendingRow {
  rank_seq: number;
  id: string;
  ruleset_version: number;
  replay_format_version: number;
  score: number;
  stage: number;
  seed: number;
  inputs: ArrayBuffer;
  duration_ticks: number;
  audit_attempts: number;
}

/**
 * Re-checks current lock ownership directly (the same EXISTS(...) condition
 * every fenced write's own WHERE clause carries — LOCK_FENCE_SQL_FRAGMENT),
 * used ONLY to disambiguate a fenced write that reported `meta.changes ===
 * 0` (see runFencedWrite()'s own doc comment for why that disambiguation is
 * necessary at all).
 */
async function stillHoldsLock(db: D1Database, ownerToken: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${LOCK_FENCE_SQL_FRAGMENT} AS held`).bind(ownerToken).first<{ held: number }>();
  return row?.held === 1;
}

type FencedWriteOutcome = 'applied' | 'lease-lost' | 'no-op-still-owner';

/**
 * Runs one fenced (LOCK_FENCE_SQL_FRAGMENT-guarded) UPDATE/DELETE and
 * classifies its outcome — the fix for a Sol cross-review finding (2026-08-
 * 20): every per-row audit write is fenced so it silently becomes a no-op
 * once this run's lease has expired (spec item 9's design), but the ORIGINAL
 * code never inspected `meta.changes` at all — it unconditionally counted
 * every write as a success and kept looping, so a lease lost between one
 * chunk's heartbeat (renewLock()) and its own per-row writes let a
 * dispossessed run "complete successfully" while quietly writing nothing,
 * violating the completion requirement that a lease-losing run must
 * actually STOP (`leaseLostMidRun`), not just fail to mutate anything.
 *
 * `changes === 0` is not by itself proof of lease loss — under this
 * design's own single-owner invariant it practically always IS (nothing
 * else can un-pending a row this run hasn't touched yet), but a direct
 * re-check of ownership (stillHoldsLock()) is cheap and removes any doubt:
 * if ownership is confirmed intact, the write's own effect (e.g. the target
 * row no longer being 'pending' for some other legitimate reason) is
 * reported as a no-op the caller should simply skip, never as a success —
 * and, critically, never mistaken for lease loss either.
 */
async function runFencedWrite(db: D1Database, ownerToken: string, statement: D1PreparedStatement): Promise<FencedWriteOutcome> {
  const result = await statement.run();
  if (result.meta.changes > 0) return 'applied';
  return (await stillHoldsLock(db, ownerToken)) ? 'no-op-still-owner' : 'lease-lost';
}

const EMPTY_RESULT: Omit<RunAuditResult, 'acquired' | 'runStartedAt'> = {
  expiredDeletedCount: 0,
  processedCount: 0,
  verifiedCount: 0,
  deletedConfirmedInvalidCount: 0,
  retriedCount: 0,
  deletedAttemptsExhaustedCount: 0,
  top10CleanedCount: 0,
  reachedTimeLimit: false,
  leaseLostMidRun: false,
};

/**
 * Runs one full audit batch: acquire lock -> delete expired pending -> drain
 * pending in chunks (verify/confirm/delete/retry) -> trim verified TOP10 ->
 * release lock. Returns a result describing what happened rather than
 * throwing for any of the "normal, expected" outcomes (lock unavailable,
 * lease lost mid-run, time limit reached) — those are all data, not errors.
 * A thrown exception here means something genuinely broke (e.g. D1 itself
 * failing), not an audit-logic outcome.
 */
export async function runAudit(options: RunAuditOptions): Promise<RunAuditResult> {
  const { db, seasonId, rulesetVersion, replayFormatVersion } = options;
  const chunkSize = options.chunkSize ?? AUDIT_CHUNK_SIZE;
  const maxRuntimeMs = options.maxRuntimeMs ?? AUDIT_MAX_RUNTIME_MS;
  const maxAttempts = options.maxAttempts ?? AUDIT_MAX_ATTEMPTS;
  const emit = options.onEvent ?? (() => {});
  const wallClockStart = Date.now();

  const lock = await acquireLock(db);
  if (!lock) {
    emit({ type: 'lock-not-acquired' });
    return { acquired: false, runStartedAt: null, ...EMPTY_RESULT };
  }
  emit({ type: 'lock-acquired', runStartedAt: lock.runStartedAt });
  const { ownerToken, runStartedAt } = lock;

  const result: RunAuditResult = { acquired: true, runStartedAt, ...EMPTY_RESULT };

  try {
    // 1. Expired-pending sweep (spec item 7's "監査ジョブの冒頭で削除").
    // created_at is milliseconds (Date.now()-based at POST time);
    // runStartedAt is D1-side unixepoch() SECONDS — converted to the same
    // millisecond epoch so the whole audit run reasons about "now" using
    // exactly one clock (D1's), never Node's.
    const expiryCutoffMs = runStartedAt * 1000 - 24 * 60 * 60 * 1000;
    const expiredDelete = await db
      .prepare(`DELETE FROM scores WHERE status = 'pending' AND created_at <= ?1 AND ${LOCK_FENCE_SQL_FRAGMENT}`)
      .bind(expiryCutoffMs, ownerToken)
      .run();
    result.expiredDeletedCount = expiredDelete.meta.changes;
    emit({ type: 'expired-pending-deleted', count: result.expiredDeletedCount });

    // 2. Drain pending in chunks until exhausted or the soft time budget is
    // spent (spec item 8's "pending が尽きるまでループ...5分で打ち切り").
    chunkLoop: for (;;) {
      // Heartbeat FIRST, before any chunk write (spec item 9's "延長...
      // changes=0 ならそのチャンクの書き込みを一切発行せず即座に処理を中断").
      const renewed = await renewLock(db, ownerToken);
      if (!renewed) {
        result.leaseLostMidRun = true;
        emit({ type: 'lease-lost-mid-chunk' });
        break;
      }

      if (Date.now() - wallClockStart > maxRuntimeMs) {
        result.reachedTimeLimit = true;
        emit({ type: 'time-limit-reached' });
        break;
      }

      const { results: rows } = await db
        .prepare(
          `SELECT rank_seq, id, ruleset_version, replay_format_version, score, stage, seed, inputs, duration_ticks, audit_attempts
           FROM scores
           WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
           ORDER BY rank_seq
           LIMIT ?2`
        )
        .bind(runStartedAt, chunkSize)
        .all<PendingRow>();
      emit({ type: 'chunk-fetched', count: rows.length });
      if (rows.length === 0) break;

      for (const row of rows) {
        result.processedCount++;
        let verdict: ReturnType<typeof verifyPendingEntry> | null = null;
        let unexpectedError: unknown = null;
        try {
          verdict = verifyPendingEntry({
            seed: row.seed,
            rle: new Uint8Array(row.inputs),
            declaredScore: row.score,
            declaredStage: row.stage,
            declaredDurationTicks: row.duration_ticks,
            declaredRulesetVersion: row.ruleset_version,
            declaredReplayFormatVersion: row.replay_format_version,
            expectedRulesetVersion: rulesetVersion,
            expectedReplayFormatVersion: replayFormatVersion,
            benchHooks: options.benchHooks,
          });
        } catch (err) {
          unexpectedError = err;
        }

        if (unexpectedError !== null) {
          // Layer 2 (spec item 3): a genuinely unexpected, non-typed
          // exception — retry via audit_attempts/next_attempt_at, or delete
          // once the retry budget (maxAttempts) is exhausted.
          const nextAttempts = row.audit_attempts + 1;
          if (nextAttempts >= maxAttempts) {
            const outcome = await runFencedWrite(
              db,
              ownerToken,
              db.prepare(`DELETE FROM scores WHERE rank_seq = ?1 AND status = 'pending' AND ${LOCK_FENCE_SQL_FRAGMENT}`).bind(row.rank_seq, ownerToken)
            );
            if (outcome === 'lease-lost') {
              result.leaseLostMidRun = true;
              emit({ type: 'lease-lost-mid-chunk' });
              break chunkLoop;
            }
            if (outcome === 'applied') {
              result.deletedAttemptsExhaustedCount++;
              emit({ type: 'entry-deleted-attempts-exhausted', id: row.id, attempts: nextAttempts });
            }
            // 'no-op-still-owner': the lease is confirmed intact but this
            // specific row was already not 'pending' — nothing to count,
            // nothing to report as a failure either. Move on.
          } else {
            const outcome = await runFencedWrite(
              db,
              ownerToken,
              db
                .prepare(
                  `UPDATE scores SET audit_attempts = ?1, next_attempt_at = unixepoch() + ?2
                   WHERE rank_seq = ?3 AND status = 'pending' AND ${LOCK_FENCE_SQL_FRAGMENT}`
                )
                .bind(nextAttempts, AUDIT_RETRY_DELAY_SECONDS, row.rank_seq, ownerToken)
            );
            if (outcome === 'lease-lost') {
              result.leaseLostMidRun = true;
              emit({ type: 'lease-lost-mid-chunk' });
              break chunkLoop;
            }
            if (outcome === 'applied') {
              result.retriedCount++;
              emit({ type: 'entry-retry-scheduled', id: row.id, attempts: nextAttempts });
            }
          }
          continue;
        }

        if (verdict!.ok) {
          // Layer confirmed-valid: overwrite with the resimulation's own
          // confirmed values (these already equal the declared ones — that
          // is exactly what verdict.ok===true means — this write is
          // defensive/explicit per spec's own "確定値で上書き" wording, not
          // a correction) and flip to verified.
          const outcome = await runFencedWrite(
            db,
            ownerToken,
            db
              .prepare(
                `UPDATE scores SET status = 'verified', score = ?1, stage = ?2, duration_ticks = ?3
                 WHERE rank_seq = ?4 AND status = 'pending' AND ${LOCK_FENCE_SQL_FRAGMENT}`
              )
              .bind(verdict!.score, verdict!.stage, verdict!.durationTicks, row.rank_seq, ownerToken)
          );
          if (outcome === 'lease-lost') {
            result.leaseLostMidRun = true;
            emit({ type: 'lease-lost-mid-chunk' });
            break chunkLoop;
          }
          if (outcome === 'applied') {
            result.verifiedCount++;
            emit({ type: 'entry-verified', id: row.id });
          }
        } else {
          // Layer 1 (spec item 3): a confirmed-invalid result
          // (VerifyReplayResult.ok===false, or a verifyPendingEntry()-level
          // declared-value/version mismatch) — delete immediately, no retry.
          const outcome = await runFencedWrite(
            db,
            ownerToken,
            db.prepare(`DELETE FROM scores WHERE rank_seq = ?1 AND status = 'pending' AND ${LOCK_FENCE_SQL_FRAGMENT}`).bind(row.rank_seq, ownerToken)
          );
          if (outcome === 'lease-lost') {
            result.leaseLostMidRun = true;
            emit({ type: 'lease-lost-mid-chunk' });
            break chunkLoop;
          }
          if (outcome === 'applied') {
            result.deletedConfirmedInvalidCount++;
            emit({ type: 'entry-deleted-confirmed-invalid', id: row.id, reason: verdict!.reason });
          }
        }
      }

      if (rows.length < chunkSize) break chunkLoop; // last (partial) chunk consumed — pending exhausted
    }

    // 3. TOP10 cleanup (spec item 10): verified-scoped on BOTH the inner
    // (candidate TOP10) and outer (delete target) queries, so an unrelated
    // TOP10-outranked *pending* row is never touched by this step.
    if (!result.leaseLostMidRun) {
      const cleanup = await db
        .prepare(
          `DELETE FROM scores
           WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2
             AND rank_seq NOT IN (
               SELECT rank_seq FROM scores
               WHERE status = 'verified' AND season_id = ?1 AND ruleset_version = ?2
               ORDER BY score DESC, rank_seq ASC
               LIMIT 10
             )
             AND ${LOCK_FENCE_SQL_FRAGMENT}`
        )
        .bind(seasonId, rulesetVersion, ownerToken)
        .run();
      result.top10CleanedCount = cleanup.meta.changes;
      emit({ type: 'top10-cleanup', deletedCount: result.top10CleanedCount });
    }

    return result;
  } finally {
    const released = await releaseLock(db, ownerToken);
    emit({ type: 'lock-released', released });
  }
}
