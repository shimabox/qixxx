// Server-side submitter-token handling (docs/plans/2026-08-22-pending-self-
// replace spec item 1): the absent/invalid/valid three-way split, and the
// exact bytes that go into submitter_hash.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { parseSubmitterToken, decodeSubmitterToken, computeSubmitterHash, SUBMITTER_TOKEN_PATTERN, SUBMITTER_TOKEN_BYTES } from './submitterToken';

describe('parseSubmitterToken', () => {
  it('accepts exactly 32 lowercase hex characters', () => {
    expect(parseSubmitterToken('0123456789abcdef0123456789abcdef')).toEqual({ kind: 'valid', token: '0123456789abcdef0123456789abcdef' });
    expect(parseSubmitterToken('0'.repeat(32))).toEqual({ kind: 'valid', token: '0'.repeat(32) });
    expect(parseSubmitterToken('f'.repeat(32))).toEqual({ kind: 'valid', token: 'f'.repeat(32) });
  });

  // The distinction this whole type exists for: an absent token is an older
  // client (or private browsing), which must keep working; an invalid one is
  // a malformed request, which is a 400. Collapsing them either 400s every
  // old client or silently swallows a real client bug.
  it('treats a missing/null token as ABSENT, not invalid', () => {
    expect(parseSubmitterToken(undefined)).toEqual({ kind: 'absent' });
    expect(parseSubmitterToken(null)).toEqual({ kind: 'absent' });
  });

  it('rejects everything that is not the exact wire format', () => {
    for (const bad of [
      '', // empty string is a value that was sent, not an omission
      '0123456789ABCDEF0123456789ABCDEF', // uppercase: the client only ever emits lowercase
      '0123456789abcdef0123456789abcde', // 31 chars
      '0123456789abcdef0123456789abcdef0', // 33 chars
      '0123456789abcdef0123456789abcdeg', // 'g' is not hex
      ' 0123456789abcdef0123456789abcdef', // leading space
      '0123456789abcdef0123456789abcdef\n', // trailing newline (the regex is anchored)
      123,
      true,
      {},
      ['0123456789abcdef0123456789abcdef'],
    ]) {
      expect(parseSubmitterToken(bad)).toEqual({ kind: 'invalid' });
    }
  });

  it('exports a 32-lowercase-hex pattern, anchored at both ends', () => {
    expect(SUBMITTER_TOKEN_PATTERN.source).toBe('^[0-9a-f]{32}$');
    expect(SUBMITTER_TOKEN_BYTES).toBe(16);
  });
});

describe('decodeSubmitterToken', () => {
  it('turns the 32 hex characters into their 16 bytes, in order', () => {
    expect(Array.from(decodeSubmitterToken('000102030405060708090a0b0c0d0e0f'))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(Array.from(decodeSubmitterToken('f'.repeat(32)))).toEqual(Array(16).fill(255));
    expect(decodeSubmitterToken('0'.repeat(32))).toHaveLength(16);
  });
});

describe('computeSubmitterHash', () => {
  // The completion criterion in the plan, spelled out as a known vector: the
  // digest must be of the DECODED BYTES, not of the hex TEXT. Both are
  // 'plausible' implementations and they produce completely different
  // digests, so only a fixed vector can tell them apart.
  it('hashes the DECODED 16 bytes, not the hex string (all-zero token vector)', async () => {
    const zeroBytesDigest = createHash('sha256').update(new Uint8Array(16)).digest('hex');
    const hexTextDigest = createHash('sha256').update('0'.repeat(32)).digest('hex');
    expect(zeroBytesDigest).toBe('374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb');

    const hash = await computeSubmitterHash('0'.repeat(32));
    expect(hash).toBe(zeroBytesDigest);
    expect(hash).not.toBe(hexTextDigest);
  });

  it('matches SHA-256 of the raw bytes for a non-trivial token too', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    expect(await computeSubmitterHash(token)).toBe('223e0a160af9da0a03e6dd2c4719c56f5d66a633cbe84e78aaa9f3735865522a');
    expect(await computeSubmitterHash(token)).toBe(createHash('sha256').update(decodeSubmitterToken(token)).digest('hex'));
  });

  it('is a 64-char lowercase hex digest that is never the token itself', async () => {
    const token = 'abcdef0123456789abcdef0123456789';
    const hash = await computeSubmitterHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
  });

  it('is deterministic, and different tokens give different hashes', async () => {
    const a = await computeSubmitterHash('0'.repeat(32));
    const b = await computeSubmitterHash('0'.repeat(31) + '1');
    expect(await computeSubmitterHash('0'.repeat(32))).toBe(a);
    expect(a).not.toBe(b);
  });
});
