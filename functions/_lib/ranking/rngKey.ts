// The "effective seed" a ranking row is unique on.
//
// A run's randomness is not the numeric seed itself but the per-stage rng
// streams src/core/rng.ts's deriveStageSeed(seed, stage) derives from it —
// FNV-1a over the string "<seed>:<stage>". FNV-1a's per-byte update is a
// bijection on the 32-bit state, so two seeds whose streams agree on ANY
// stage have identical hash state right after "<seed>:" and therefore agree
// on EVERY stage (e.g. 1485211075 and 2522981067). Such seeds are the same
// game: identical boards, identical enemy motion, one replay valid under
// both. A UNIQUE index on the numeric seed alone cannot see that; an index
// on deriveStageSeed(seed, 1) — one representative of the equivalence class
// — can. Equal seeds have equal keys, so it refuses a copied replay
// re-submitted under the same seed and under a colliding one alike
// (migrations/0005_scores_rng_key.sql).
//
// That migration computes the very same value in SQL for rows that predate
// the column; migrations/0005_scores_rng_key.test.ts pins the two
// implementations to each other.
import { deriveStageSeed } from '../../../src/core/rng';

/** Unsigned 32-bit key identifying the rng streams `seed` produces; equal for seeds that play identically. */
export function computeRngKey(seed: number): number {
  return deriveStageSeed(seed, 1);
}
