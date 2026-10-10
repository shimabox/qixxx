import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAuditMode } from './auditMode';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAuditMode', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['enabled', 'enabled'],
    ['ENABLED', 'ENABLED'],
    ['off', 'off'],
    ['false', 'false'],
    ['0', '0'],
    ['an arbitrary string', 'audit-me-maybe'],
    ['a near miss', 'disable'],
  ])('falls back to the audited mode for %s', (_label, raw) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveAuditMode(raw)).toBe('enabled');
  });

  it.each([
    ['disabled', 'disabled'],
    ['DISABLED', 'DISABLED'],
    ['mixed case', 'Disabled'],
    ['surrounding whitespace', '  disabled\n'],
  ])('turns the audit off only for the literal "disabled" (%s)', (_label, raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveAuditMode(raw)).toBe('disabled');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent for the values that need no warning (unset, empty, enabled)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of [undefined, '', ' ', 'enabled', ' Enabled ']) resolveAuditMode(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about an unrecognized value without echoing the value itself', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secretLooking = 'sk-live-should-never-reach-a-log';
    expect(resolveAuditMode(secretLooking)).toBe('enabled');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain(secretLooking);
    expect(logged).not.toContain('should-never');
  });
});
