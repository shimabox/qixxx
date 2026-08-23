// Log redaction helpers for the audit job (docs/ranking-audit-runbook.md
// §"ログ方針"). This repository is PUBLIC, and so is every GitHub Actions
// run log the audit workflow (.github/workflows/ranking-audit.yml) produces
// — anyone can read them without signing in. Everything scripts/audit/ ever
// prints is therefore treated as published output, not as an operator's
// private console.
//
// What may be logged (the runbook's table is the authority; this module
// implements the error-shaped part of it):
// OK — aggregate counts, durations, event kinds, values already
// public through the API (a row's share `id`, a confirmed
// score), and a rejection REASON KIND ('declared-score-
// mismatch'), never the compared values themselves.
// NEVER — ip_hash (a hash still correlates submissions to one person
// across rows and against a rainbow/known-IP table),
// submitter_hash and the raw submitter token behind it (same
// correlation argument, plus the raw token IS the ownership
// proof that lets a pending row be replaced), the audit lock's
// owner_token, anything key-shaped (RANKING_IP_HASH_KEY),
// and raw error objects: a thrown Error's `message`/`stack` can
// carry file paths, connection strings, SQL fragments and
// account identifiers that nothing in this codebase controls.
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

/**
 * The ONLY error class names this module will ever echo — a fixed allowlist,
 * not a shape test. An earlier implementation accepted any identifier-shaped `name`,
 * which meant a thrown object could publish attacker- or environment-chosen
 * text simply by naming itself `Secret_supersecret`: `name` is an ordinary
 * writable property, so "looks like a
 * class name" is not evidence that it IS one.
 *
 * Each entry is a class the audit stack can actually reach:
 *
 * - The 8 ECMAScript built-in error constructors: what the runtime itself
 * throws (a bug in the simulator surfaces as TypeError/RangeError, D1 and
 * Node/undici failures surface as plain Error, Promise.any as
 * AggregateError). Their names are fixed by the language spec.
 * - MissingIpHashKeyError — functions/_lib/ranking/ipHash.ts, thrown by
 * requireIpHashKey() at this command's own entrypoint check.
 * - RleDecodeError — src/core/rle.ts, thrown while decoding a replay BLOB.
 * verifyReplay() converts the ones it expects into a 'malformed-replay'
 * result, but the class is reachable from any other decode call site.
 * - ReplayAbortedError — src/core/replayEngine.ts, thrown by the chunked
 * replay driver verifyReplay() itself calls (simulateReplayFromRle).
 *
 * Anything else — including a genuine but unlisted class — is reported as
 * 'UnknownError'. That is the intended trade: an unlisted class costs one
 * local re-run with AUDIT_LOG_ERROR_DETAIL to identify, while echoing an
 * unvetted `name` costs a public leak. Add to this list only after confirming
 * where the class is thrown.
 */
export const ALLOWED_ERROR_NAMES: readonly string[] = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'MissingIpHashKeyError',
  'RleDecodeError',
  'ReplayAbortedError',
  'RemoteD1ConfigurationError',
  'RemoteD1RequestError',
  'RemoteD1ResponseError',
  'RemoteD1QueryError',
];

const ALLOWED_ERROR_NAME_SET = new Set(ALLOWED_ERROR_NAMES);

/**
 * Reads one property off an arbitrary thrown value, returning null unless it
 * yields a plain string.
 *
 * The try/catch is load-bearing, not defensive noise: the argument is
 * `unknown` — a value some other
 * code chose to throw — so the PROPERTY ACCESS ITSELF can throw. A getter
 * that throws, or a Proxy with a throwing `get` trap, turns `err.name` into
 * an exception raised INSIDE the sanitizer. That would be the worst possible
 * place for one: the sanitizer's only callers are catch handlers (the CLI
 * bootstrap's among them), so throwing here escapes the very handler meant to
 * redact the failure, and the runtime prints the raw stack instead. These
 * functions must therefore be structurally incapable of throwing.
 */
function readStringProperty(source: unknown, key: 'name' | 'message'): string | null {
  try {
    const value = (source as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The publishable summary of a thrown value: its error class name when that
 * name is on ALLOWED_ERROR_NAMES, otherwise 'UnknownError'. Never includes the
 * message or the stack, and never throws — see this module's doc comment and
 * readStringProperty()'s.
 */
export function safeErrorName(err: unknown): string {
  const name = readStringProperty(err, 'name');
  if (name !== null && ALLOWED_ERROR_NAME_SET.has(name)) return name;
  return 'UnknownError';
}

/**
 * The FIRST LINE of an error's message, control characters stripped and
 * truncated to MAX_ERROR_DETAIL_CHARS. Only for logs the operator has
 * explicitly opted into (see ERROR_DETAIL_ENV_VAR): the first line alone
 * still can't be assumed safe for a public log, it is merely bounded and
 * stack-free. Never throws (see readStringProperty()); an unreadable message
 * yields an empty string.
 */
export function safeErrorDetail(err: unknown): string {
  const raw = readStringProperty(err, 'message') ?? '';
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
