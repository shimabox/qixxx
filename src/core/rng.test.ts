import { describe, it, expect } from 'vitest';
import { mulberry32, hashString, deriveStageSeed } from './rng';

describe('mulberry32', () => {
  it('produces the same sequence of values for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces a different sequence for a different seed', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('always returns values in [0, 1)', () => {
    const rng = mulberry32(999);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('does not repeat the very first value across many distinct seeds (sanity check for a broken constant generator)', () => {
    const firsts = new Set<number>();
    for (let seed = 0; seed < 50; seed++) {
      firsts.add(mulberry32(seed)());
    }
    expect(firsts.size).toBeGreaterThan(40);
  });

  it('accepts negative/non-integer seeds without throwing (coerced via >>> 0)', () => {
    expect(() => mulberry32(-42)()).not.toThrow();
    expect(() => mulberry32(3.7)()).not.toThrow();
  });
});

describe('hashString', () => {
  it('is deterministic: same string always hashes to the same value', () => {
    expect(hashString('qixxx-daily-2026-08-11')).toBe(hashString('qixxx-daily-2026-08-11'));
  });

  it('produces different hashes for different strings (no trivial collisions on adjacent dates)', () => {
    const h1 = hashString('qixxx-daily-2026-08-11');
    const h2 = hashString('qixxx-daily-2026-08-12');
    expect(h1).not.toBe(h2);
  });

  it('always returns a non-negative (unsigned 32-bit) integer', () => {
    for (const s of ['', 'a', 'qixxx', '2026-08-11', 'x'.repeat(500)]) {
      const h = hashString(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is sensitive to input order (not just character multiset)', () => {
    expect(hashString('ab')).not.toBe(hashString('ba'));
  });
});

describe('deriveStageSeed', () => {
  it('is deterministic: same (seed, stage) always derives the same sub-seed', () => {
    expect(deriveStageSeed(42, 3)).toBe(deriveStageSeed(42, 3));
  });

  it('derives a different sub-seed for a different stage number, same base seed', () => {
    const seed = 42;
    const subSeeds = new Set<number>();
    for (let stage = 1; stage <= 10; stage++) {
      subSeeds.add(deriveStageSeed(seed, stage));
    }
    expect(subSeeds.size).toBe(10);
  });

  it('derives a different sub-seed for a different base seed, same stage', () => {
    expect(deriveStageSeed(1, 1)).not.toBe(deriveStageSeed(2, 1));
  });

  it("depends only on (seed, stage) — is unaffected by anything resembling prior rng consumption", () => {
    // There's no "consume N values first" concept for a pure function of
    // (seed, stage) — re-deriving the same pair from scratch, any number of
    // times, always yields the identical sub-seed. This is the property
    // core/session.ts's per-stage rng construction relies on.
    const first = deriveStageSeed(777, 5);
    for (let i = 0; i < 5; i++) {
      expect(deriveStageSeed(777, 5)).toBe(first);
    }
  });
});
