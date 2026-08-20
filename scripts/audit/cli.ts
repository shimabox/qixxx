// Manual/CI entrypoint for the async audit job (docs/plans/2026-08-19-
// ranking-free-async spec items 6/11/12). Run locally via:
//
//   npx vite-node scripts/audit/cli.ts
//
// (see docs/ranking-audit-runbook.md for the full manual-run walkthrough —
// applying migrations first, seeding a pending row via a real POST, then
// running this). The GitHub Actions workflow (.github/workflows/
// ranking-audit.yml) invokes the exact same command for a `workflow_dispatch`
// -triggered run — no separate "CI mode" branch in this file.
//
// D1 connection: always LocalPlatformProxyD1Adapter (scripts/audit/
// d1Adapter.ts) in this round — remote/production D1 access is out of this
// round's scope (RemoteD1Adapter is a documented stub, not wired in here).
import { LocalPlatformProxyD1Adapter } from './d1Adapter';
import { runAudit, type AuditEvent } from './runAudit';
import { requireIpHashKey, MissingIpHashKeyError } from '../../functions/_lib/ranking/ipHash';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../functions/_lib/ranking/season';
import { safeErrorName, safeErrorDetail, errorDetailEnabled, ERROR_DETAIL_ENV_VAR } from './logSafety';

// EVERYTHING THIS FILE PRINTS IS PUBLIC. The GitHub Actions run log for
// .github/workflows/ranking-audit.yml is world-readable (public repository),
// so this entrypoint's stdout/stderr is published output — see
// docs/ranking-audit-runbook.md §"ログ方針" for the field-by-field policy and
// scripts/audit/logSafety.ts for the error-redaction helpers that implement
// it. AuditEvent's own doc comment carries the same rule for the event
// payloads printed verbatim below.
function logEvent(event: AuditEvent): void {
  console.log(`[audit] ${JSON.stringify(event)}`);
}

/** The publishable one-line rendering of a thrown value (class name only, plus an opted-in local detail). */
function describeError(err: unknown): string {
  const detail = errorDetailEnabled(process.env) ? ` ${safeErrorDetail(err)}` : '';
  return `${safeErrorName(err)}${detail}`;
}

async function main(): Promise<void> {
  // Fail-closed entrypoint check (docs/plans/2026-08-19-ranking-free-async
  // spec item 7: "POST ハンドラ/監査コマンドの入口で未設定を検出し、DB 操作
  // 前に失敗させる") — this command does not itself compute any ip_hash
  // (audit rows already have theirs from POST time), but the same
  // fail-closed check is required at this entrypoint too, before any D1
  // operation, for exactly the reason the POST handler has it: neither
  // runtime has a build-time-guaranteed "is the secret bound" phase to hook
  // a one-time check into instead.
  try {
    requireIpHashKey(process.env.RANKING_IP_HASH_KEY);
  } catch (err) {
    if (err instanceof MissingIpHashKeyError) {
      console.error('[audit] RANKING_IP_HASH_KEY is not set in the environment — refusing to start (see docs/ranking-audit-runbook.md).');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const adapter = new LocalPlatformProxyD1Adapter();
  try {
    const db = await adapter.getDb();
    const result = await runAudit({
      db,
      seasonId: CURRENT_SEASON_ID,
      rulesetVersion: RULESET_VERSION,
      replayFormatVersion: REPLAY_FORMAT_VERSION,
      // Local-debugging opt-in only; the workflow never sets this variable.
      includeErrorDetail: errorDetailEnabled(process.env),
      onEvent: logEvent,
    });

    if (!result.acquired) {
      console.log('[audit] could not acquire audit_lock — another run is presumably in progress. Exiting (this is a normal, expected outcome, not a failure).');
      return;
    }

    // A run that lost its lease mid-way (or found the lock no longer its own
    // at release time — `lockReleased === false`) did NOT finish its work:
    // some pending rows and/or the TOP10 cleanup were deliberately skipped.
    // That is not the same "normal, expected outcome" as failing to acquire
    // the lock above, so it must not be logged (or exited) as a clean run —
    // it means a lease outlived by the run itself, which the 10-minute lease
    // vs 5-minute runtime budget (spec item 8) is supposed to make impossible.
    const incomplete = result.leaseLostMidRun || !result.lockReleased;
    console.log(
      `[audit] ${incomplete ? 'INCOMPLETE (lease lost mid-run — see leaseLostMidRun/lockReleased below; the next run resumes the remaining work).' : 'done.'} ` +
        `runStartedAt(D1 unixepoch)=${result.runStartedAt} expiredDeleted=${result.expiredDeletedCount} processed=${result.processedCount} ` +
        `verified=${result.verifiedCount} deletedConfirmedInvalid=${result.deletedConfirmedInvalidCount} retried=${result.retriedCount} ` +
        `deletedAttemptsExhausted=${result.deletedAttemptsExhaustedCount} top10Cleaned=${result.top10CleanedCount} ` +
        `reachedTimeLimit=${result.reachedTimeLimit} leaseLostMidRun=${result.leaseLostMidRun} lockReleased=${result.lockReleased}`
    );
    if (incomplete) process.exitCode = 1;
  } finally {
    await adapter.dispose();
  }
}

main().catch((err) => {
  // Deliberately NOT `console.error('...', err)`: printing the error object
  // publishes its message AND stack — absolute file paths, and for a D1/
  // network failure potentially endpoint or account details. The class name
  // is what a public log gets; re-run locally with AUDIT_LOG_ERROR_DETAIL=1
  // (never on the workflow) to see the message's first line too.
  console.error(`[audit] fatal error: ${describeError(err)} (re-run locally with ${ERROR_DETAIL_ENV_VAR}=1 for the error message)`);
  process.exitCode = 1;
});
