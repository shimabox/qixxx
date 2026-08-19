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

function logEvent(event: AuditEvent): void {
  console.log(`[audit] ${JSON.stringify(event)}`);
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
      onEvent: logEvent,
    });

    if (!result.acquired) {
      console.log('[audit] could not acquire audit_lock — another run is presumably in progress. Exiting (this is a normal, expected outcome, not a failure).');
      return;
    }

    console.log(
      `[audit] done. runStartedAt(D1 unixepoch)=${result.runStartedAt} expiredDeleted=${result.expiredDeletedCount} processed=${result.processedCount} ` +
        `verified=${result.verifiedCount} deletedConfirmedInvalid=${result.deletedConfirmedInvalidCount} retried=${result.retriedCount} ` +
        `deletedAttemptsExhausted=${result.deletedAttemptsExhaustedCount} top10Cleaned=${result.top10CleanedCount} ` +
        `reachedTimeLimit=${result.reachedTimeLimit} leaseLostMidRun=${result.leaseLostMidRun}`
    );
  } finally {
    await adapter.dispose();
  }
}

main().catch((err) => {
  console.error('[audit] fatal error:', err);
  process.exitCode = 1;
});
