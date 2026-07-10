import { describe, it, expect } from 'vitest';
import { generateShareId } from './shareId';

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
