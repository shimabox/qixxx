import { describe, it, expect } from 'vitest';
import { generateShareId, isShareId } from './shareId';

describe('generateShareId', () => {
  it('produces an id of at least 16 characters (docs/plan-cloudflare-x-share.md Phase 2)', () => {
    const id = generateShareId();
    expect(id.length).toBeGreaterThanOrEqual(16);
  });

  it('produces only lowercase hex characters', () => {
    const id = generateShareId();
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('is derived from the injected random-byte source (deterministic for a fixed input)', () => {
    const fixedBytes = () => new Uint8Array([0, 1, 2, 254, 255]);
    expect(generateShareId(fixedBytes)).toBe('0001 02fe ff'.replace(/ /g, ''));
  });

  it('produces different ids across calls with the real RNG (no realistic collision)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateShareId()));
    expect(ids.size).toBe(50);
  });
});

describe('isShareId', () => {
  it('accepts exactly what generateShareId() produces', () => {
    for (let i = 0; i < 20; i++) {
      expect(isShareId(generateShareId())).toBe(true);
    }
    expect(isShareId('0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('rejects anything that could never have been minted', () => {
    const valid = '0123456789abcdef0123456789abcdef';
    for (const value of [
      null,
      undefined,
      '',
      'abc',
      valid.slice(0, 31),
      `${valid}0`,
      valid.toUpperCase(),
      `${valid.slice(0, 31)}g`,
      `${valid.slice(0, 31)} `,
      'x'.repeat(600),
      42,
    ]) {
      expect(isShareId(value)).toBe(false);
    }
  });
});
