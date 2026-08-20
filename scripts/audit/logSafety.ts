// Log redaction helpers for the audit job (docs/ranking-audit-runbook.md
// §"ログ方針"). This repository is PUBLIC, and so is every GitHub Actions
// run log the audit workflow (.github/workflows/ranking-audit.yml) produces
// — anyone can read them without signing in. Everything scripts/audit/ ever
// prints is therefore treated as published output, not as an operator's
// private console.
//
// What may be logged (the runbook's table is the authority; this module
// implements the error-shaped part of it):
//   OK      — aggregate counts, durations, event kinds, values already
//             public through the API (a row's share `id`, a confirmed
//             score), and a rejection REASON KIND ('declared-score-
//             mismatch'), never the compared values themselves.
//   NEVER   — ip_hash (a hash still correlates submissions to one person
//             across rows and against a rainbow/known-IP table), the audit
//             lock's owner_token, anything key-shaped (RANKING_IP_HASH_KEY),
//             and raw error objects: a thrown Error's `message`/`stack` can
//             carry file paths, connection strings, SQL fragments and
//             account identifiers that nothing in this codebase controls.
//
// Hence: an unexpected exception is reduced to its CLASS NAME by default —
// enough to tell a TypeError from a D1 failure and route a retry, with no
// attacker-controlled or environment-derived text in it. The message's first
// line can be opted into for LOCAL debugging via the AUDIT_LOG_ERROR_DETAIL
// environment variable, which must never be set on the workflow.

/** Environment variable that opts a LOCAL run into logging error message text. Never set in .github/workflows/ranking-audit.yml — see this module's doc comment. */
export const ERROR_DETAIL_ENV_VAR = 'AUDIT_LOG_ERROR_DETAIL';

/** Hard cap on an opted-in error detail, so even a local log can't be flooded by a megabyte-long message. */
export const MAX_ERROR_DETAIL_CHARS = 200;

// A class name is an identifier by construction; anything else reaching this
// (a thrown string, a forged `name` property, an Error subclass built from
// interpolated text) is NOT a class name and is not echoed.
const SAFE_ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * The publishable summary of a thrown value: its error class name, or
 * 'UnknownError' when it has none this module is willing to echo. Never
 * includes the message or the stack — see this module's doc comment.
 */
export function safeErrorName(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (typeof name === 'string' && SAFE_ERROR_NAME.test(name)) return name;
  return 'UnknownError';
}

/**
 * The FIRST LINE of an error's message, control characters stripped and
 * truncated to MAX_ERROR_DETAIL_CHARS. Only for logs the operator has
 * explicitly opted into (see ERROR_DETAIL_ENV_VAR): the first line alone
 * still can't be assumed safe for a public log, it is merely bounded and
 * stack-free.
 */
export function safeErrorDetail(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  const raw = typeof message === 'string' ? message : '';
  // eslint-disable-next-line no-control-regex
  const firstLine = raw.split(/[\r\n]/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (firstLine.length <= MAX_ERROR_DETAIL_CHARS) return firstLine;
  return `${firstLine.slice(0, MAX_ERROR_DETAIL_CHARS)}...(truncated)`;
}

/** Whether this process opted into logging error message text (ERROR_DETAIL_ENV_VAR set to a non-empty value other than '0'/'false'). */
export function errorDetailEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[ERROR_DETAIL_ENV_VAR];
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}
