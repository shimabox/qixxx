import { describe, it, expect } from 'vitest';
import { validateName, validateXHandle, MAX_NAME_LENGTH } from './nameValidation';

describe('validateName', () => {
  it('accepts a plain ASCII name', () => {
    expect(validateName('shimabox')).toEqual({ ok: true, value: 'shimabox' });
  });

  it('accepts Unicode (non-Latin scripts, emoji)', () => {
    const japanese = String.fromCharCode(0x3057, 0x307e, 0x3076, 0x30fc); // "しまぶー"
    expect(validateName(japanese)).toEqual({ ok: true, value: japanese });
    const withEmoji = 'player-' + String.fromCodePoint(0x1f3ae); // video game emoji
    expect(validateName(withEmoji)).toEqual({ ok: true, value: withEmoji });
  });

  it('trims surrounding whitespace', () => {
    expect(validateName('  padded  ')).toEqual({ ok: true, value: 'padded' });
  });

  it('treats an absent/empty name as "not provided" (ok, empty value), not an error', () => {
    expect(validateName(undefined)).toEqual({ ok: true, value: '' });
    expect(validateName(null)).toEqual({ ok: true, value: '' });
    expect(validateName('')).toEqual({ ok: true, value: '' });
    expect(validateName('   ')).toEqual({ ok: true, value: '' });
  });

  it('rejects a non-string', () => {
    expect(validateName(123).ok).toBe(false);
  });

  it('rejects a name longer than MAX_NAME_LENGTH', () => {
    const tooLong = 'a'.repeat(MAX_NAME_LENGTH + 1);
    expect(validateName(tooLong).ok).toBe(false);
    expect(validateName('a'.repeat(MAX_NAME_LENGTH)).ok).toBe(true);
  });

  it('rejects control characters (NUL, ESC, DEL)', () => {
    expect(validateName('bad' + String.fromCharCode(0x00) + 'name').ok).toBe(false);
    expect(validateName('bad' + String.fromCharCode(0x1b) + 'name').ok).toBe(false);
    expect(validateName('bad' + String.fromCharCode(0x7f) + 'name').ok).toBe(false);
  });

  it('rejects invisible/formatting characters that could make a name render as blank or reordered', () => {
    expect(validateName('a' + String.fromCharCode(0x200b) + 'b').ok).toBe(false); // zero-width space
    expect(validateName('a' + String.fromCharCode(0xfeff) + 'b').ok).toBe(false); // BOM
    expect(validateName('a' + String.fromCharCode(0x202e) + 'b').ok).toBe(false); // right-to-left override
  });

  it('the "HTML metacharacter" XSS-shaped completion-condition example is accepted as an inert string', () => {
    // No HTML-escaping is expected/needed here — this validator's job is
    // only content-shape validation; XSS safety is main.ts's job (task 4:
    // textContent-only rendering, never innerHTML).
    const input = '<img src=x>'; // within MAX_NAME_LENGTH
    expect(validateName(input)).toEqual({ ok: true, value: input });
  });
});

describe('validateXHandle', () => {
  it('accepts a bare handle', () => {
    expect(validateXHandle('shimabox')).toEqual({ ok: true, value: 'shimabox' });
  });

  it('strips a single leading @', () => {
    expect(validateXHandle('@shimabox')).toEqual({ ok: true, value: 'shimabox' });
  });

  it('accepts digits and underscores', () => {
    expect(validateXHandle('a_b_123')).toEqual({ ok: true, value: 'a_b_123' });
  });

  it('treats an absent/empty handle as "not provided" (ok, null value)', () => {
    expect(validateXHandle(undefined)).toEqual({ ok: true, value: null });
    expect(validateXHandle(null)).toEqual({ ok: true, value: null });
    expect(validateXHandle('')).toEqual({ ok: true, value: null });
  });

  it('rejects a handle over 15 characters (after stripping @)', () => {
    expect(validateXHandle('a'.repeat(16)).ok).toBe(false);
    expect(validateXHandle('a'.repeat(15)).ok).toBe(true);
  });

  it('rejects characters outside [A-Za-z0-9_]', () => {
    expect(validateXHandle('bad-handle').ok).toBe(false);
    expect(validateXHandle('bad handle').ok).toBe(false);
    const japanese = String.fromCharCode(0x3057, 0x307e, 0x3076, 0x30fc);
    expect(validateXHandle(japanese).ok).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(validateXHandle(123).ok).toBe(false);
  });
});
