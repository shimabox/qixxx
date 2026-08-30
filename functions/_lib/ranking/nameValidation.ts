// Name / X-handle validation for POST /api/scores. Pure — no Request/KV dependency —
// so it's directly unit-testable, matching functions/_lib/validation.ts's
// existing pattern for the share feature.
import { MAX_NAME_LENGTH } from '../../../src/core/rankingLimits';

// Generous but bounded — long enough for real names in most scripts, short
// enough to keep the ranking overlay's row layout predictable.
export { MAX_NAME_LENGTH };

// Control characters (C0 + the C1 range, including DEL) and a set of
// invisible/formatting Unicode characters (zero-width spaces/joiners,
// bidi-override control characters, word joiner, BOM) that can be used to
// make a name render as blank, reorder surrounding text, or otherwise look
// like something it isn't. Unicode *letters* (any script) are otherwise
// unrestricted. Written with
// explicit \uXXXX escapes (rather than the literal characters themselves)
// so this file stays readable/diffable in any editor or encoding.
const CONTROL_CHAR_RANGES = '\\u0000-\\u001F\\u007F-\\u009F';
const INVISIBLE_CHAR_RANGES = '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF';
const FORBIDDEN_CHAR_PATTERN = new RegExp(`[${CONTROL_CHAR_RANGES}${INVISIBLE_CHAR_RANGES}]`);

export type NameValidationResult = { ok: true; value: string } | { ok: false; reason: string };

/** Validates + trims a display name. Empty (after trimming) is treated as "not provided" (ok, value ''), not an error — POST /api/scores requires at least one of name/x_handle itself. */
export function validateName(raw: unknown): NameValidationResult {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, reason: 'name must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: '' };
  if ([...trimmed].length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `name must be at most ${MAX_NAME_LENGTH} characters` };
  }
  if (FORBIDDEN_CHAR_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'name contains control or invisible characters' };
  }
  return { ok: true, value: trimmed };
}

// Twitter/X's own handle character set, checked *after* stripping a single leading '@'
// if present — a player may type either "shimabox" or "@shimabox".
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

export type XHandleValidationResult = { ok: true; value: string | null } | { ok: false; reason: string };

/** Validates + normalizes (strips a leading '@') an X handle. Empty/absent is valid (value: null) — POST /api/scores requires at least one of name/x_handle itself, not both. */
export function validateXHandle(raw: unknown): XHandleValidationResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'x_handle must be a string' };
  const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
  if (!HANDLE_PATTERN.test(stripped)) {
    return { ok: false, reason: 'x_handle must match ^[A-Za-z0-9_]{1,15}$ (after removing a leading @)' };
  }
  return { ok: true, value: stripped };
}
