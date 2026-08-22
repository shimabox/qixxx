// Shared tuning constants for the async audit job. These are normal-operation
// guidelines, never guarantees —
// GitHub Actions' `schedule` trigger can delay or skip a run outright, so
// nothing downstream may assume these bounds are hit exactly. Centralized
// here (rather than inlined at each call site) so scripts/audit/runAudit.ts,
// the GitHub Actions workflow's own comments, and docs/ranking-audit-runbook.md
// all cite the same numbers.
import { LOCK_LEASE_SECONDS } from './lock';

/** Pending rows fetched per verification chunk: 50 rows/chunk. */
export const AUDIT_CHUNK_SIZE = 50;

/** Soft five-minute wall-clock budget for one audit run, checked between chunks rather than preemptively mid-chunk. */
export const AUDIT_MAX_RUNTIME_MS = 5 * 60 * 1000;

/** A pending row is deleted after this many unexpected-error attempts rather than retried again. */
export const AUDIT_MAX_ATTEMPTS = 3;

/**
 * How far into the future `next_attempt_at` is pushed after an unexpected-
 * error attempt (`next_attempt_at = now + cron
 * 間隔`) — set equal to AUDIT_CRON_INTERVAL_MINUTES below, so a retried row
 * is normally picked up again on the very next scheduled run, never the
 * same one (guaranteed structurally regardless of this value — see
 * runStartedAt's own doc comment in lock.ts — this constant only controls
 * how soon a *later* run becomes eligible to retry it).
 */
export const AUDIT_CRON_INTERVAL_MINUTES = 5;
export const AUDIT_RETRY_DELAY_SECONDS = AUDIT_CRON_INTERVAL_MINUTES * 60;

/** Rate-limit rows untouched for longer than this are eligible for cleanup. */
export const RANKING_RATE_LIMIT_RETENTION_SECONDS = 24 * 60 * 60;

// Sanity self-check: the 10-minute lease must exceed the five-minute runtime.
// The lock lease must outlast the longest a single run is
// expected to take, or a still-running job could lose its own lease
// mid-chunk under entirely normal conditions.
if (LOCK_LEASE_SECONDS <= AUDIT_MAX_RUNTIME_MS / 1000) {
  throw new Error('invariant violated: LOCK_LEASE_SECONDS must exceed AUDIT_MAX_RUNTIME_MS');
}
