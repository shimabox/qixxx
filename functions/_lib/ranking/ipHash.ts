// ip_hash computation for the Free-tier async-audit pending cap. The source
// value is CF-Connecting-IP,
// hashed with HMAC-SHA-256 keyed by a secret environment variable — never a
// fixed/public salt (IP addresses are low-entropy enough that a public salt
// is brute-forceable) and never the raw IP itself.
//
// Uses only Web Crypto (`crypto.subtle`), so this module runs unchanged in
// both the Cloudflare Pages Functions runtime (functions/api/scores.ts) and
// a plain Node 20+ process (the audit script, scripts/audit/ — Node's global
// `crypto.subtle` is the same standard API since Node 19), matching
// verifyReplay.ts's own "portable to a plain Node script" design note.
//
// Fail-closed by construction: requireIpHashKey() throws
// MissingIpHashKeyError whenever the key is absent/empty, and every caller
// (the POST handler, the audit command entrypoint) is required to call it
// BEFORE any D1 operation — Pages Functions has no strict startup phase to
// hook a one-time "did the secret get bound" check into, so the check has to
// happen at the top of each entrypoint instead. There is deliberately no
// fallback to hashing (or storing) the raw IP.
export class MissingIpHashKeyError extends Error {
  constructor() {
    super('RANKING_IP_HASH_KEY is not set — refusing to proceed (fail-closed, no raw-IP fallback)');
    this.name = 'MissingIpHashKeyError';
  }
}

/** Throws MissingIpHashKeyError for an absent/empty key; otherwise returns it unchanged. Call this before any DB operation in every entrypoint that needs ip_hash. */
export function requireIpHashKey(rawKey: string | undefined | null): string {
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    throw new MissingIpHashKeyError();
  }
  return rawKey;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** HMAC-SHA-256(key, ip), hex-encoded. `key` must already have passed requireIpHashKey(). */
export async function computeIpHash(ip: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(ip));
  return bytesToHex(new Uint8Array(signature));
}
