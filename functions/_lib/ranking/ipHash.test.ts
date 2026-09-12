import { describe, it, expect } from 'vitest';
import { requireIpHashKey, computeIpHash, normalizeClientIp, MissingIpHashKeyError } from './ipHash';

describe('requireIpHashKey (fail-closed gate)', () => {
  it('returns the key unchanged when present and non-empty', () => {
    expect(requireIpHashKey('a-real-secret')).toBe('a-real-secret');
  });

  it('throws MissingIpHashKeyError for undefined', () => {
    expect(() => requireIpHashKey(undefined)).toThrow(MissingIpHashKeyError);
  });

  it('throws MissingIpHashKeyError for null', () => {
    expect(() => requireIpHashKey(null)).toThrow(MissingIpHashKeyError);
  });

  it('throws MissingIpHashKeyError for an empty string (not merely absent)', () => {
    expect(() => requireIpHashKey('')).toThrow(MissingIpHashKeyError);
  });
});

describe('computeIpHash (HMAC-SHA-256)', () => {
  it('is deterministic for the same (ip, key)', async () => {
    const a = await computeIpHash('203.0.113.1', 'key-a');
    const b = await computeIpHash('203.0.113.1', 'key-a');
    expect(a).toBe(b);
  });

  it('produces a 64-hex-character (32-byte) SHA-256-sized digest', async () => {
    const digest = await computeIpHash('203.0.113.1', 'key-a');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different IPs under the same key', async () => {
    const a = await computeIpHash('203.0.113.1', 'key-a');
    const b = await computeIpHash('203.0.113.2', 'key-a');
    expect(a).not.toBe(b);
  });

  it('differs for the same IP under different keys — a key rotation invalidates old hashes rather than colliding with them', async () => {
    const a = await computeIpHash('203.0.113.1', 'key-a');
    const b = await computeIpHash('203.0.113.1', 'key-b');
    expect(a).not.toBe(b);
  });

  it('never equals a plain (unkeyed) SHA-256 of the IP — this is HMAC, not a fixed-salt digest', async () => {
    const hmac = await computeIpHash('203.0.113.1', 'key-a');
    const plainDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('203.0.113.1'));
    const plainHex = [...new Uint8Array(plainDigest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hmac).not.toBe(plainHex);
  });
});

describe('normalizeClientIp (IPv6 → /64 prefix; per-subscriber keying)', () => {
  it('returns IPv4 unchanged', () => {
    expect(normalizeClientIp('203.0.113.1')).toBe('203.0.113.1');
  });

  it('maps every address in one /64 to the same canonical key', () => {
    const a = normalizeClientIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = normalizeClientIp('2001:db8:1:2:0000:0000:0000:0001');
    const c = normalizeClientIp('2001:db8:1:2::');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('keeps different /64s distinct', () => {
    expect(normalizeClientIp('2001:db8:1:2::1')).not.toBe(normalizeClientIp('2001:db8:1:3::1'));
  });

  it('canonicalizes case, leading zeros and `::` placement', () => {
    const expected = '2001:db8:0:0::/64';
    expect(normalizeClientIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe(expected);
    expect(normalizeClientIp('2001:db8::1')).toBe(expected);
    expect(normalizeClientIp('2001:db8:0:0::1')).toBe(expected);
  });

  it('handles `::` compression inside the prefix half', () => {
    expect(normalizeClientIp('2001::5:6:7:8')).toBe('2001:0:0:0::/64');
    expect(normalizeClientIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeClientIp('::')).toBe('0:0:0:0::/64');
  });

  it('unwraps an IPv4-mapped IPv6 address to plain IPv4', () => {
    expect(normalizeClientIp('::ffff:203.0.113.1')).toBe('203.0.113.1');
    expect(normalizeClientIp('::FFFF:cb00:7101')).toBe('203.0.113.1');
  });

  it('strips surrounding brackets', () => {
    expect(normalizeClientIp('[2001:db8:1:2::1]')).toBe('2001:db8:1:2::/64');
  });

  it("passes the 'unknown' fallback and malformed input through unchanged", () => {
    for (const raw of ['unknown', '', '2001:db8:::1', '2001:db8:1:2:3:4:5:6:7', '2001:db8:1:2:3:4:5', '1:2:3:4:5:6:7:gggg', '::ffff:999.0.0.1', 'not an ip', '1.2.3', '1.2.3.256']) {
      expect(normalizeClientIp(raw)).toBe(raw);
    }
  });

  it('feeds computeIpHash one hash per /64 rather than per address', async () => {
    const a = await computeIpHash(normalizeClientIp('2001:db8:1:2:aaaa::1'), 'key-a');
    const b = await computeIpHash(normalizeClientIp('2001:db8:1:2:bbbb::2'), 'key-a');
    expect(a).toBe(b);
  });
});
