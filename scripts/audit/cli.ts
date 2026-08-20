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
// ---------------------------------------------------------------------------
// WHY THIS FILE IS A BOOTSTRAP AND NOT THE COMMAND ITSELF
// ---------------------------------------------------------------------------
// This entrypoint's output is PUBLIC (world-readable GitHub Actions run logs
// on a public repository), so no thrown value may reach it unredacted —
// docs/ranking-audit-runbook.md §5 "ログ方針". An earlier revision imported
// the whole command statically and wrapped only `main().catch(...)`, which a
// user review (2026-08-20) showed to be a hole: a throw during MODULE
// INITIALIZATION of any statically-imported module happens BEFORE any of this
// file's own code runs, so the catch never sees it and the runner prints a raw
// stack instead. That path is real, not hypothetical — scripts/audit/
// constants.ts asserts its lease/runtime invariant with a top-level `throw`.
//
// Hence: the command body lives in ./auditCommand and is loaded with a
// DYNAMIC import inside the try/catch below, so an initialization throw
// anywhere in that import graph (constants.ts, lock.ts, d1Adapter.ts,
// wrangler, functions/_lib/...) arrives as a rejected promise this file
// sanitizes like any other failure.
//
// The one static import is ./logSafety, which is deliberately kept
// dependency-free (it imports nothing and its module body is only constants,
// a regex and a Set — nothing that can throw). scripts/audit/cli.test.ts
// asserts that this stays true: no other static import may be added here.
import { safeErrorName, safeErrorDetail, errorDetailEnabled, ERROR_DETAIL_ENV_VAR } from './logSafety';

/** The publishable one-line rendering of a thrown value (class name only, plus an opted-in local detail). */
function describeError(err: unknown): string {
  const detail = errorDetailEnabled(process.env) ? ` ${safeErrorDetail(err)}` : '';
  return `${safeErrorName(err)}${detail}`;
}

async function bootstrap(): Promise<void> {
  const { runAuditCommand } = await import('./auditCommand');
  await runAuditCommand();
}

bootstrap().catch((err: unknown) => {
  // Deliberately NOT `console.error('...', err)`: printing the error object
  // publishes its message AND stack — absolute file paths, and for a D1/
  // network failure potentially endpoint or account details. The class name
  // is what a public log gets; re-run locally with AUDIT_LOG_ERROR_DETAIL=1
  // (never on the workflow) to see the message's first line too.
  console.error(`[audit] fatal error: ${describeError(err)} (re-run locally with ${ERROR_DETAIL_ENV_VAR}=1 for the error message)`);
  process.exitCode = 1;
});
