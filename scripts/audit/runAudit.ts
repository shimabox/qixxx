// The async audit job is pure orchestration over a plain D1Database (obtained
// via scripts/audit/d1Adapter.ts by the CLI entrypoint, or directly by
// integration tests). Verifies pending rows via functions/_lib/ranking/
// verifyPendingEntry() (which itself calls the UNCHANGED verifyReplay()),
// confirms or deletes them, retries genuinely-unexpected errors, sweeps
// expired pending rows, and trims verified rows back down to the TOP10 —
// all under the audit_lock mutex (scripts/audit/lock.ts), with every write
// statement fenced by LOCK_FENCE_SQL_FRAGMENT as a second ownership check.
import { verifyPendingEntry } from '../../functions/_lib/ranking/verifyPendingEntry';
import { pendingFreshnessCutoff } from '../../functions/_lib/ranking/pendingGate';
import type { BenchVerifyHooks } from '../../functions/_lib/ranking/benchHooks';
import { acquireLock, renewLock, releaseLock, LOCK_FENCE_SQL_FRAGMENT } from './lock';
import { safeErrorName, safeErrorDetail } from './logSafety';
import { AUDIT_CHUNK_SIZE, AUDIT_MAX_RUNTIME_MS, AUDIT_MAX_ATTEMPTS, AUDIT_RETRY_DELAY_SECONDS } from './constants';
import type { AuditD1Database, AuditD1PreparedStatement } from './d1Adapter';

export interface RunAuditOptions {
  db: AuditD1Database;
  seasonId: number;
  rulesetVersion: number;
  replayFormatVersion: number;
  chunkSize?: number;
  maxRuntimeMs?: number;
  maxAttempts?: number;
  /** Test-only hook, mirroring verifyReplay()'s own — never set in a real audit run. */
  benchHooks?: BenchVerifyHooks;
  /**
   * Adds an unexpected exception's (first-line, truncated) message text to
   * the retry/exhausted events. OFF by default and never enabled on a
   * scheduled launchd run: an error message can carry paths/connection
   * details that must not reach a shared log (scripts/audit/logSafety.ts).
   * The CLI sets this from AUDIT_LOG_ERROR_DETAIL for local debugging only.
   */
  includeErrorDetail?: boolean;
  /** Progress/log callback — never required for correctness, purely observational (the CLI entrypoint wires this to console.log). */
  onEvent?: (event: AuditEvent) => void;
}

/**
 * Every event below is written to a log treated as shareable (the CLI
 * entrypoint prints them verbatim as JSON, and this repository's launchd run
 * logs get handed around for debugging) — so each field here is part of the
 * shareable output, not an operator-only diagnostic. Fields are restricted to event kinds,
 * aggregate counts, already-public row `id`s and rejection reason KINDS;
 * never ip_hash, never the lock's owner_token, never raw error text. Adding a
 * field means re-checking it against docs/ranking-audit-runbook.md §5's
 * "ログ方針" table — runAudit.test.ts's ALLOWED_EVENT_FIELDS ("public-log
 * hygiene") fails until a new field is added there too, so one cannot appear
 * in the published log without that decision being made deliberately.
 */
export type AuditEvent =
  | { type: 'lock-not-acquired' }
  | { type: 'lock-acquired'; runStartedAt: number }
  | { type: 'expired-pending-deleted'; count: number }
  | { type: 'chunk-fetched'; count: number }
  | { type: 'entry-verified'; id: string }
  | { type: 'entry-deleted-confirmed-invalid'; id: string; reason: string }
  | { type: 'entry-retry-scheduled'; id: string; attempts: number; errorName: string; errorDetail?: string }
  | { type: 'entry-deleted-attempts-exhausted'; id: string; attempts: number; errorName: string; errorDetail?: string }
  | { type: 'lease-lost-mid-chunk' }
  | { type: 'time-limit-reached' }
  | { type: 'lease-lost-before-top10-cleanup' }
  | { type: 'top10-cleanup'; deletedCount: number }
  | { type: 'lease-lost-at-release' }
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
  /**
   * Whether this run's own releaseLock() actually released a lease it still
   * owned. `false` means the lock was NOT ours anymore at release time (lease
   * expired, or already taken over by a rival owner) — the lock itself is
   * free/owned-by-someone-else either way, but the run must NOT be reported
   * as a clean completion: it means the lease was lost at some point after
   * the last fenced write this run checked, so `leaseLostMidRun` is forced
   * true alongside it (see runAudit()'s `finally` block). Always `false` when
   * `acquired` is false — a run that never held the lock never released one.
   */
  lockReleased: boolean;
}

interface PendingRow {
  rank_seq: number;
  id: string;
  season_id: number;
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
async function stillHoldsLock(db: AuditD1Database, ownerToken: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${LOCK_FENCE_SQL_FRAGMENT} AS held`).bind(ownerToken).first<{ held: number }>();
  return row?.held === 1;
}

type FencedWriteOutcome = 'applied' | 'lease-lost' | 'no-op-still-owner';

interface FencedWriteResult {
  outcome: FencedWriteOutcome;
  /** `meta.changes` of the write — 0 for both no-op outcomes, >0 only for 'applied'. */
  changes: number;
}

/**
 * Runs one fenced (LOCK_FENCE_SQL_FRAGMENT-guarded) UPDATE/DELETE and
 * classifies its outcome. Every per-row audit write is fenced so it silently
 * becomes a no-op once this run's lease has expired. Inspecting `meta.changes`
 * is necessary because a lease can be lost between one chunk's heartbeat
 * (renewLock()) and that same chunk's per-row writes: a run that never looked
 * at `changes` would "complete successfully" while quietly writing nothing,
 * when what a lease-losing run must do is STOP (`leaseLostMidRun`).
 *
 * `changes === 0` is not by itself proof of lease loss — under the lock's
 * single-owner invariant it practically always IS (nothing else can
 * un-pending a row this run hasn't touched yet), but a direct re-check of
 * ownership (stillHoldsLock()) is cheap and removes any doubt:
 * if ownership is confirmed intact, the write's own effect (e.g. the target
 * row no longer being 'pending' for some other legitimate reason) is
 * reported as a no-op the caller should simply skip, never as a success —
 * and, critically, never mistaken for lease loss either.
 *
 * Used by every fenced write in this file, per-row and set-based alike. The
 * TOP10 cleanup can also lose its lease after the final chunk and before the
 * DELETE. Note the cleanup's `changes === 0` legitimately
 * happens on most runs (nothing to trim), which is exactly why the ownership
 * re-check, not the raw count, has to be what distinguishes the two.
 */
async function runFencedWrite(db: AuditD1Database, ownerToken: string, statement: AuditD1PreparedStatement): Promise<FencedWriteResult> {
  const result = await statement.run();
  const changes = result.meta.changes;
  if (changes > 0) return { outcome: 'applied', changes };
  return { outcome: (await stillHoldsLock(db, ownerToken)) ? 'no-op-still-owner' : 'lease-lost', changes: 0 };
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
  lockReleased: false,
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
  const includeErrorDetail = options.includeErrorDetail ?? false;
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
    // 1. Expired-pending sweep ("監査ジョブの冒頭で削除"), against the SAME
    // 72h boundary every reader uses:
    // expired = `created_at <= cutoff` — pendingFreshnessCutoff() is shared
    // with GET /api/ranking, POST /api/scores and the replay endpoint, so the
    // sweep can never delete a row a reader still considered fresh.
    //
    // created_at is milliseconds (Date.now()-based at POST time);
    // runStartedAt is D1-side unixepoch() SECONDS — converted to the same
    // millisecond epoch so the whole audit run reasons about "now" using
    // exactly one clock (D1's), never Node's.
    const expiryCutoffMs = pendingFreshnessCutoff(runStartedAt * 1000);
    const expiredDelete = await db
      .prepare(`DELETE FROM scores WHERE status = 'pending' AND created_at <= ?1 AND ${LOCK_FENCE_SQL_FRAGMENT}`)
      .bind(expiryCutoffMs, ownerToken)
      .run();
    result.expiredDeletedCount = expiredDelete.meta.changes;
    emit({ type: 'expired-pending-deleted', count: result.expiredDeletedCount });

    // 2. Drain pending in chunks until exhausted or the soft time budget is
    // spent: stop after five minutes or when no pending rows remain.
    chunkLoop: for (;;) {
      // Heartbeat FIRST, before any chunk write. If renewal changes zero rows,
      // stop immediately without issuing writes for that chunk.
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
          // Deliberately NOT filtered by season_id/ruleset_version: an old
          // season's leftover pending rows have no other sweeper, so the
          // audit must still pick them up — and then delete them, which
          // verifyPendingEntry()'s 'season-mismatch'/'ruleset-version-
          // mismatch' classification (below) is what makes happen. Filtering
          // them out here instead would leave them pending forever, invisible
          // to every ranking query yet still holding their replay BLOBs.
          `SELECT rank_seq, id, season_id, ruleset_version, replay_format_version, score, stage, seed, inputs, duration_ticks, audit_attempts
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
            declaredSeasonId: row.season_id,
            expectedSeasonId: seasonId,
            expectedRulesetVersion: rulesetVersion,
            expectedReplayFormatVersion: replayFormatVersion,
            benchHooks: options.benchHooks,
          });
        } catch (err) {
          unexpectedError = err;
        }

        if (unexpectedError !== null) {
          // Layer 2: a genuinely unexpected, non-typed
          // exception — retry via audit_attempts/next_attempt_at, or delete
          // once the retry budget (maxAttempts) is exhausted.
          //
          // The exception is REDACTED to its class name before it can reach
          // the (public) log — scripts/audit/logSafety.ts explains why an
          // error's own message/stack is never publishable. Enough survives
          // to tell "the simulator threw a TypeError" from "D1 timed out",
          // which is all this path needs; the message's first line is
          // available locally behind AUDIT_LOG_ERROR_DETAIL.
          const errorFields = {
            errorName: safeErrorName(unexpectedError),
            ...(includeErrorDetail ? { errorDetail: safeErrorDetail(unexpectedError) } : {}),
          };
          const nextAttempts = row.audit_attempts + 1;
          if (nextAttempts >= maxAttempts) {
            const { outcome } = await runFencedWrite(
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
              emit({ type: 'entry-deleted-attempts-exhausted', id: row.id, attempts: nextAttempts, ...errorFields });
            }
            // 'no-op-still-owner': the lease is confirmed intact but this
            // specific row was already not 'pending' — nothing to count,
            // nothing to report as a failure either. Move on.
          } else {
            const { outcome } = await runFencedWrite(
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
              emit({ type: 'entry-retry-scheduled', id: row.id, attempts: nextAttempts, ...errorFields });
            }
          }
          continue;
        }

        if (verdict!.ok) {
          // Layer confirmed-valid: overwrite with the resimulation's own
          // confirmed values (these already equal the declared ones — that
          // is exactly what verdict.ok===true means, so the write is
          // deliberately explicit rather than a correction: what lands on a
          // verified row is always what the resimulation produced, never
          // what the client declared) and flip to verified.
          //
          // `submitter_hash = NULL` in the same UPDATE: the browser-ownership token
          // exists solely so a POST can replace its OWN pending row, and a
          // verified row is never replaceable. Clearing it here — rather than
          // leaving it to rot on the row — is what keeps the token from
          // quietly becoming a durable, cross-session browser identifier
          // sitting in a table whose contents are partly public.
          const { outcome } = await runFencedWrite(
            db,
            ownerToken,
            db
              .prepare(
                `UPDATE scores SET status = 'verified', score = ?1, stage = ?2, duration_ticks = ?3, submitter_hash = NULL
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
          // Layer 1: a confirmed-invalid result
          // (VerifyReplayResult.ok===false, or a verifyPendingEntry()-level
          // declared-value/version mismatch) — delete immediately, no retry.
          const { outcome } = await runFencedWrite(
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

    // 3. TOP10 cleanup: verified-scoped on BOTH the inner
    // (candidate TOP10) and outer (delete target) queries, so an unrelated
    // TOP10-outranked *pending* row is never touched by this step. Fenced and
    // outcome-checked exactly like the per-row writes above (runFencedWrite())
    // — the fence alone would make a dispossessed run's cleanup a silent
    // no-op, indistinguishable from the (very common) "nothing to trim" case,
    // so the ownership re-check is what keeps a lease lost between the final
    // chunk and this statement from being reported as a clean run.
    if (!result.leaseLostMidRun) {
      const { outcome, changes } = await runFencedWrite(
        db,
        ownerToken,
        db
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
      );
      if (outcome === 'lease-lost') {
        // Out-of-TOP10 verified rows are deliberately left in place: they are
        // the new owner's to trim now, and this run must report itself as
        // stopped, not as a completed one that happened to trim nothing.
        result.leaseLostMidRun = true;
        emit({ type: 'lease-lost-before-top10-cleanup' });
      } else {
        result.top10CleanedCount = changes;
        emit({ type: 'top10-cleanup', deletedCount: result.top10CleanedCount });
      }
    }

    return result;
  } finally {
    // `result` is the very object the `return` above hands back (the return
    // expression is evaluated BEFORE this block runs, but it evaluated to
    // this object's reference), so mutating it here IS observable to the
    // caller — the release outcome belongs to the run's result, not just to
    // the log.
    const released = await releaseLock(db, ownerToken);
    result.lockReleased = released;
    if (!released && !result.leaseLostMidRun) {
      // The lease was still ours at the last fenced write we checked, yet gone
      // by release time: it WAS lost mid-run, we simply found out at the last
      // possible moment. Reporting it as anything other than a lease-lost run
      // would be the same silent "success" this whole check exists to prevent.
      result.leaseLostMidRun = true;
      emit({ type: 'lease-lost-at-release' });
    }
    emit({ type: 'lock-released', released });
  }
}
