// The browser half of pending self-replacement (docs/plans/2026-08-22-
// pending-self-replace spec item 1).
//
// What this is for, in one sentence: without it, a player whose three
// submissions are still awaiting audit loses their fourth — and best — run of
// the session to a 429, because the server has no way to tell that the rows
// standing in the way are that same player's own. A token stored here, sent
// with every submission and hashed server-side into `scores.submitter_hash`,
// is exactly that proof and nothing more.
//
// Design constraints worth keeping:
//   - 16 bytes from crypto.getRandomValues(), never Math.random(): the whole
//     security argument for the server storing an UNKEYED hash of this value
//     (functions/_lib/ranking/submitterToken.ts) is that 128 bits of CSPRNG
//     output has no enumerable candidate space. A weak generator would quietly
//     invalidate that argument and turn submitter_hash into something
//     guessable — i.e. into a way to delete OTHER people's pending rows.
//   - No localStorage, no token, no problem. Private-browsing modes and
//     storage-blocked embeddings either hide `localStorage` or throw on touch.
//     Every one of those paths returns null here and the submission simply
//     goes out without a token: the player keeps the ordinary behavior
//     (submit works; a full pending queue is a 429 they can retry) and loses
//     only the self-replacement upgrade. Failing the SUBMIT itself over a
//     storage quirk would be a far worse trade.
//   - The token is not an identity. It is scoped to replacing this browser's
//     own not-yet-audited rows, and the audit erases the server-side hash the
//     moment a row is confirmed.

/** The wire format, mirrored on the server by functions/_lib/ranking/submitterToken.ts's SUBMITTER_TOKEN_PATTERN (src/ deliberately does not import from functions/ — src/ui/submitterToken.test.ts pins the two against each other instead). */
export const SUBMITTER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** 16 bytes = 128 bits. */
export const SUBMITTER_TOKEN_BYTES = 16;

/** localStorage key. Namespaced so it can never collide with the high-score key this game already keeps. */
export const SUBMITTER_TOKEN_STORAGE_KEY = 'qixxx:ranking:submitterToken';

/** The one bit of localStorage this module uses — narrowed to a parameter so the generator/persistence logic is testable in vitest's `node` environment, which has no localStorage at all. */
export interface TokenStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** A fresh token: 16 crypto-random bytes rendered as 32 LOWERCASE hex characters. */
export function generateSubmitterToken(): string {
  const bytes = new Uint8Array(SUBMITTER_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The ambient localStorage, or null when it cannot be used.
 *
 * Both halves matter: some browsers omit the property, others expose it and
 * throw a SecurityError on the FIRST ACCESS of the property itself, so this
 * has to be inside a try rather than a truthiness check. A probe write is not
 * attempted — a getItem/setItem that throws is caught at the call site in
 * getOrCreateSubmitterToken(), which is the same outcome with one less write
 * to somebody's storage.
 */
function ambientStorage(): TokenStorage | null {
  try {
    const storage = globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * This browser's submitter token, minting and persisting one on first use.
 *
 * Returns null whenever storage is unusable — see the module header: a
 * token that cannot be persisted is worse than none, because a per-page-load
 * token would let a reloading player accumulate rows they can no longer
 * replace, quietly using up their own IP's pending quota.
 *
 * A stored value that no longer matches the wire format (hand-edited storage,
 * or a value written by some future format) is replaced rather than sent: the
 * server answers a malformed token with a 400, so passing one through would
 * break submission entirely for that browser, with nothing the player could
 * do about it.
 */
export function getOrCreateSubmitterToken(storage: TokenStorage | null = ambientStorage()): string | null {
  if (!storage) return null;
  try {
    const existing = storage.getItem(SUBMITTER_TOKEN_STORAGE_KEY);
    if (typeof existing === 'string' && SUBMITTER_TOKEN_PATTERN.test(existing)) return existing;
    const minted = generateSubmitterToken();
    storage.setItem(SUBMITTER_TOKEN_STORAGE_KEY, minted);
    return minted;
  } catch {
    // Quota exceeded, storage disabled mid-session, a throwing getter — all
    // the same answer: submit without a token.
    return null;
  }
}
