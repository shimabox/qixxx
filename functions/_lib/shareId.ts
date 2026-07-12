// Unguessable share-ID generation (docs/plan-cloudflare-x-share.md Phase 2:
// "推測不能な ID（crypto.getRandomValues ベース 16 文字以上）"). 16 random
// bytes hex-encoded = 32 characters, comfortably over the 16-character floor
// and with 128 bits of entropy (no realistic brute-force/enumeration risk).
const ID_BYTE_LENGTH = 16;

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
