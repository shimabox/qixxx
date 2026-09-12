// Unguessable share-ID generation (docs/plan-cloudflare-x-share.md Phase 2:
// "推測不能な ID（crypto.getRandomValues ベース 16 文字以上）"). 16 random
// bytes hex-encoded = 32 characters, comfortably over the 16-character floor
// and with 128 bits of entropy (no realistic brute-force/enumeration risk).
const ID_BYTE_LENGTH = 16;

/** Exactly the shape generateShareId() produces: 32 lowercase hex characters. */
const SHARE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * True only for a string generateShareId() could have produced. The read
 * paths (GET /s, GET /og) gate on this before touching KV: anything else
 * can never resolve to a record, so rejecting it up front saves a billed KV
 * read and keeps an over-long key (KV's 512-byte key limit throws) from
 * surfacing as a 500 instead of a 404.
 */
export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Generates a share ID. `randomBytes` is injectable purely for testing
 * (default uses the real Web Crypto RNG, available both in the Workers
 * runtime and in Node 20's global `crypto`, so no polyfill/import is needed
 * in either environment).
 */
export function generateShareId(randomBytes: () => Uint8Array = defaultRandomBytes): string {
  return toHex(randomBytes());
}

function defaultRandomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ID_BYTE_LENGTH));
}
