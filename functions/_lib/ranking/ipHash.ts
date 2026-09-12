// ip_hash computation for the Free-tier async-audit pending cap. The source
// value is CF-Connecting-IP, first passed through normalizeClientIp() (IPv6
// rounded to its /64 prefix — see the bottom of this file), then
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

// ---------------------------------------------------------------------------
// Client-IP normalization (applied BEFORE hashing / keying).
//
// Every per-IP control in this codebase (the D1 ranking rate limit, the
// per-IP pending cap, the KV /share rate limit) keys on the client address.
// A residential IPv6 allocation is typically a whole /64 (2^64 addresses),
// and hosts freely rotate the interface-identifier half (privacy
// extensions), so keying on the full 128-bit address lets one subscriber
// look like an unbounded number of distinct clients. Rounding IPv6 down to
// its /64 network prefix makes the per-IP limits mean "per subscriber"
// again. IPv4 addresses are already per-subscriber (or coarser, behind
// CGNAT) and pass through unchanged.
// ---------------------------------------------------------------------------

/** IPv6 prefix length the client address is rounded to. */
export const IPV6_CLIENT_PREFIX_BITS = 64;

function parseIpv4Octets(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parses an IPv6 literal into its 8 16-bit groups, or null if it is not a
 * valid IPv6 address. Accepts `::` compression, mixed case, leading zeros
 * and an embedded dotted-quad tail (e.g. `::ffff:203.0.113.1`).
 */
function parseIpv6Hextets(text: string): number[] | null {
  let s = text.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;

  // Embedded IPv4 tail → two trailing hextets.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Octets(tail);
    if (v4 === null) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const splitGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = splitGroups(halves[0]);
  const rest = halves.length === 2 ? splitGroups(halves[1]) : [];

  const toHextet = (group: string): number | null => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : null);
  const headNums: number[] = [];
  for (const g of head) {
    const n = toHextet(g);
    if (n === null) return null;
    headNums.push(n);
  }
  const restNums: number[] = [];
  for (const g of rest) {
    const n = toHextet(g);
    if (n === null) return null;
    restNums.push(n);
  }

  if (halves.length === 1) {
    return headNums.length === 8 ? headNums : null;
  }
  // `::` must stand in for at least one zero group.
  if (headNums.length + restNums.length > 7) return null;
  const zeros = new Array<number>(8 - headNums.length - restNums.length).fill(0);
  return [...headNums, ...zeros, ...restNums];
}

/**
 * Normalizes a client IP string to the granularity per-IP limits should key
 * on:
 *
 * - IPv4 → returned unchanged.
 * - IPv6 → its /64 network prefix in one canonical spelling
 *   (`2001:db8:1:2::/64`), so every address a subscriber rotates through —
 *   and every textual spelling of it (case, leading zeros, `::` placement)
 *   — maps to the same key. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
 *   is unwrapped to the plain IPv4 form.
 * - Anything else (the `'unknown'` fallback, malformed input) → returned
 *   unchanged so it still contributes a stable key and is never silently
 *   widened or dropped.
 *
 * Pure and synchronous; call it on the raw `CF-Connecting-IP` value before
 * computeIpHash() or any other keying.
 */
export function normalizeClientIp(ip: string): string {
  if (parseIpv4Octets(ip) !== null) return ip;
  const hextets = parseIpv6Hextets(ip);
  if (hextets === null) return ip;

  const isIpv4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (isIpv4Mapped) {
    return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join('.');
  }

  const prefixGroups = IPV6_CLIENT_PREFIX_BITS / 16;
  const prefix = hextets
    .slice(0, prefixGroups)
    .map((h) => h.toString(16))
    .join(':');
  return `${prefix}::/${IPV6_CLIENT_PREFIX_BITS}`;
}
