// Submitter-token handling for the pending self-replacement path.
//
// The token is a BROWSER OWNERSHIP proof, nothing more: it exists so that
// POST /api/scores can tell "one of the pending rows in the way is MINE"
// from "they all belong to somebody else", and may therefore replace the
// former with a strictly better score of its own. It is never an identity,
// never an authentication credential, and never outlives the pending window
// (the audit's verified-flip clears submitter_hash — see
// scripts/audit/runAudit.ts).
//
// Two decisions worth stating outright, because both look like mistakes
// next to functions/_lib/ranking/ipHash.ts and are not:
//
// 1. UNKEYED SHA-256, not HMAC. ipHash.ts needs a secret key because an IP
// address is drawn from a tiny, enumerable space — a public hash of one
// is reversible by brute force. A submitter token is 128 bits of
// crypto.getRandomValues() output; there is no space to enumerate, so
// there is no key worth managing. Introducing one here would add an
// operational failure mode (a rotated/missing key silently orphaning
// every live pending row's ownership) to buy nothing.
//
// 2. The hash input is the DECODED 16 BYTES, not the 32-character hex
// text. Hashing the text would work equally well as a lookup key, but
// the byte form is the token's actual value and the hex is merely how
// it survives JSON — pinning the byte form keeps the digest defined by
// the token rather than by a transport detail (and keeps the digest
// stable if the wire encoding ever changes).
//
// The RAW TOKEN IS NEVER STORED AND NEVER LOGGED (docs/ranking-audit-runbook.md
// §5.1 lists it alongside ip_hash as forbidden output).

/** The one accepted wire form: exactly 32 LOWERCASE hex characters (= 16 bytes). Uppercase is rejected rather than normalized — the client always emits lowercase, so anything else did not come from src/ui/submitterToken.ts. */
export const SUBMITTER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The token's length in bytes, before hex encoding. 16 bytes = 128 bits. */
export const SUBMITTER_TOKEN_BYTES = 16;

/**
 * What the request body's token field turned out to be.
 *
 * 'absent' and 'invalid' are deliberately DIFFERENT outcomes:
 * absent means an older client (or a private-browsing session with no
 * localStorage) that simply cannot participate in replacement and must keep
 * working exactly as before, while invalid means a malformed request, which
 * is a 400 like any other bad field. Collapsing them would either 400 every
 * old client or silently swallow a genuine client bug.
 *
 * The line between the two is drawn at the FIELD, not at its value: absent
 * means the key is not in the submitted JSON object at all. Anything present
 * — `null` included — is an ATTACHED token and is judged on its format.
 *
 * That reading is exact rather than merely conservative, because JSON has no
 * `undefined`: a missing key is the only way this function can ever see
 * `undefined`, so "the value is undefined" and "the key was never sent" are
 * the same statement with nothing left to disambiguate. A client that
 * genuinely has no token omits the key (src/ui/ranking.ts passes
 * `?? undefined`, which JSON.stringify drops), so `{"submitterToken": null}`
 * is a client bug or a hand-written request — precisely the thing keeping
 * these two cases apart is meant to surface, rather than wave through under
 * the "old client" allowance.
 */
export type SubmitterTokenParse = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; token: string };

/** Classifies the raw `submitterToken` value off the request body. Absent means the key was not sent at all (`undefined`); EVERY other value — `null`, a non-string, or a string that isn't 32 lowercase hex characters — is invalid. */
export function parseSubmitterToken(raw: unknown): SubmitterTokenParse {
  if (raw === undefined) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'invalid' };
  if (!SUBMITTER_TOKEN_PATTERN.test(raw)) return { kind: 'invalid' };
  return { kind: 'valid', token: raw };
}

/** Decodes a validated 32-char hex token into its 16 raw bytes. Assumes the value already passed parseSubmitterToken(). */
export function decodeSubmitterToken(token: string): Uint8Array {
  const bytes = new Uint8Array(SUBMITTER_TOKEN_BYTES);
  for (let i = 0; i < SUBMITTER_TOKEN_BYTES; i++) {
    bytes[i] = Number.parseInt(token.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * `submitter_hash`: the hex SHA-256 digest of the token's DECODED 16 bytes
 * (see this module's header for why unkeyed, and why bytes rather than text).
 * The argument must already have passed parseSubmitterToken().
 */
export async function computeSubmitterHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', decodeSubmitterToken(token));
  return bytesToHex(new Uint8Array(digest));
}
