// Deterministic random-number sourcing (daily-seed-time-attack request task
// 2): a self-contained mulberry32 PRNG plus a string->seed hash, with no
// dependency added to package.json (both are a handful of lines each). Pure
// functions — no DOM/Canvas/localStorage dependency, matching every other
// module in src/core/. Consumed by GameSession (core/session.ts) to derive a
// per-stage sub-seed from the single numeric seed carried by the
// `?seed=<number>` URL parameter, so every run started with the same
// `?seed=` sees an identical board, stage by stage, regardless of how many
// rng calls a previous stage's simulation happened to consume.
import { Rng } from './enemy';

/**
 * mulberry32: a small, fast, decent-quality deterministic PRNG (public
 * domain algorithm by Tommy Ettinger). Returns a fresh `Rng` closed over its
 * own 32-bit state, seeded from `seed` (coerced to an unsigned 32-bit int).
 * Two `mulberry32` instances constructed with the same `seed` always produce
 * the exact same sequence of `[0, 1)` values, call for call.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a, a small non-cryptographic 32-bit string hash: turns an arbitrary
 * string into an unsigned 32-bit integer suitable as a `mulberry32` seed.
 * Deterministic across runs/machines (no reliance on String.prototype's own
 * hash, which JS doesn't expose anyway). Used internally by
 * `deriveStageSeed` below, which hashes a `"<seed>:<stage>"` string to get
 * each stage its own independent sub-seed.
 */
export function hashString(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derives a stage-specific sub-seed from a base `seed` and a `stage` number.
 * Deliberately NOT "keep consuming the same rng stream across stages" — that
 * would make stage N's starting layout depend on exactly how many rng calls
 * stage N-1's simulation happened to make (itself a function of how long the
 * player took to clear it), breaking the "every player sees the same board"
 * guarantee this whole feature exists for. Hashing `seed` and `stage`
 * together instead gives every stage its own independent, fresh rng stream
 * that depends only on (seed, stage) — never on prior stages' durations.
 */
export function deriveStageSeed(seed: number, stage: number): number {
  return hashString(`${Math.floor(seed)}:${Math.floor(stage)}`);
}
