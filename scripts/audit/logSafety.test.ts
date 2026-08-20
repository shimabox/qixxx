// Unit tests for the audit job's log-redaction helpers (docs/ranking-audit-
// runbook.md §"ログ方針"). The end-to-end guarantee — that a REAL runAudit()
// run never emits a forbidden field — lives in runAudit.test.ts's
// "public-log hygiene" describe; this file covers the primitives.
import { describe, it, expect } from 'vitest';
import { safeErrorName, safeErrorDetail, errorDetailEnabled, ERROR_DETAIL_ENV_VAR, MAX_ERROR_DETAIL_CHARS } from './logSafety';

/** A realistically hostile error: a multi-line message with a path/connection-shaped first line, plus a real stack. */
function messyError(): Error {
  const err = new TypeError('connect ECONNREFUSED 10.1.2.3:5432 (token=abcdef0123456789abcdef0123456789)\nat /Users/someone/secret-project/scripts/audit/cli.ts:42');
  return err;
}

describe('safeErrorName', () => {
  it('returns the error class name for ordinary errors', () => {
    expect(safeErrorName(new TypeError('boom'))).toBe('TypeError');
    expect(safeErrorName(new Error('boom'))).toBe('Error');
  });

  it('never returns the message or the stack', () => {
    const summary = safeErrorName(messyError());
    expect(summary).toBe('TypeError');
    expect(summary).not.toContain('ECONNREFUSED');
    expect(summary).not.toContain('/Users/');
  });

  it('refuses a name that is not a plain identifier (a forged/interpolated one)', () => {
    const forged = new Error('boom');
    forged.name = 'Error: leaked /etc/passwd';
    expect(safeErrorName(forged)).toBe('UnknownError');
  });

  it('refuses an over-long name rather than echoing it', () => {
    const forged = new Error('boom');
    forged.name = 'A'.repeat(200);
    expect(safeErrorName(forged)).toBe('UnknownError');
  });

  it('handles non-Error throws without echoing them', () => {
    expect(safeErrorName('a thrown string with a secret')).toBe('UnknownError');
    expect(safeErrorName(null)).toBe('UnknownError');
    expect(safeErrorName(undefined)).toBe('UnknownError');
    expect(safeErrorName({ name: 42 })).toBe('UnknownError');
  });
});

describe('safeErrorDetail', () => {
  it('keeps only the first line — never the stack lines that follow it', () => {
    const detail = safeErrorDetail(messyError());
    expect(detail).toBe('connect ECONNREFUSED 10.1.2.3:5432 (token=abcdef0123456789abcdef0123456789)');
    expect(detail).not.toContain('cli.ts:42');
    expect(detail).not.toContain('\n');
  });

  it('truncates to MAX_ERROR_DETAIL_CHARS', () => {
    const detail = safeErrorDetail(new Error('x'.repeat(5000)));
    expect(detail.startsWith('x'.repeat(MAX_ERROR_DETAIL_CHARS))).toBe(true);
    expect(detail).toBe(`${'x'.repeat(MAX_ERROR_DETAIL_CHARS)}...(truncated)`);
  });

  it('strips control characters (no ANSI escapes or stray control bytes smuggled into a log line)', () => {
    const ESC = String.fromCharCode(27);
    const BELL = String.fromCharCode(7);
    const detail = safeErrorDetail(new Error(`before${ESC}[31mafter${BELL}end`));
    expect(detail).toBe('before [31mafter end');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f]/.test(detail)).toBe(false);
  });

  it('returns an empty string for a non-Error throw (nothing to summarize, nothing echoed)', () => {
    expect(safeErrorDetail('a thrown string')).toBe('');
    expect(safeErrorDetail(null)).toBe('');
    expect(safeErrorDetail({ message: 42 })).toBe('');
  });
});

describe('errorDetailEnabled', () => {
  it('is OFF by default — the workflow env never sets the variable', () => {
    expect(errorDetailEnabled({})).toBe(false);
    expect(errorDetailEnabled({ [ERROR_DETAIL_ENV_VAR]: '' })).toBe(false);
  });

  it('treats an explicit disabling value as off', () => {
    expect(errorDetailEnabled({ [ERROR_DETAIL_ENV_VAR]: '0' })).toBe(false);
    expect(errorDetailEnabled({ [ERROR_DETAIL_ENV_VAR]: 'false' })).toBe(false);
    expect(errorDetailEnabled({ [ERROR_DETAIL_ENV_VAR]: ' FALSE ' })).toBe(false);
  });

  it('is on for an explicit opt-in', () => {
    expect(errorDetailEnabled({ [ERROR_DETAIL_ENV_VAR]: '1' })).toBe(true);
    expect(errorDetailEnabled({ [ERROR_DETAIL_ENV_VAR]: 'true' })).toBe(true);
  });
});
