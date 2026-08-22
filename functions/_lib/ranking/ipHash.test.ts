import { describe, it, expect } from 'vitest';
import { requireIpHashKey, computeIpHash, MissingIpHashKeyError } from './ipHash';

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
