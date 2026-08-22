// Seed validation for POST /api/scores before simulation. Pure — no Request/KV dependency —
// so it's directly unit-testable, matching nameValidation.ts's pattern in
// this same directory.
//
// The only seed a legitimate client ever submits is the one src/main.ts's
// generateNormalRunSeed() produced, and that is sourced from
// `crypto.getRandomValues(new Uint32Array(1))` — i.e. always an integer in
// [0, 2^32 - 1]. Anything outside that set (a float, a negative number, a
// value past the uint32 ceiling) is by construction not a real run's seed,
// so this narrows the accepted input to exactly the shape the client can
// actually generate rather than merely "some finite number". Narrowing here
// also means verifyReplay()'s resimulation — the expensive step — is never
// reached by a seed the game itself could not have used.
//
// Note on the seed's downstream use: src/core/rng.ts derives each stage's
// sub-seed by hashing the seed's *decimal string*, so `s` and `s + 2**32`
// are not equivalent boards; this check is an input-surface narrowing, not a
// fix for an aliasing bug.

/** Exclusive upper bound: seeds come from a Uint32Array, so 2^32 - 1 is the largest legal value. */
export const MAX_SEED = 0xffffffff;

export type SeedValidationResult = { ok: true; value: number } | { ok: false; reason: string };

/** Validates a submitted seed as a uint32 (integer, 0 <= seed <= 2^32 - 1). Rejects NaN/Infinity/non-integers implicitly via Number.isInteger(). */
export function validateSeed(raw: unknown): SeedValidationResult {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, reason: 'seed must be an integer' };
  }
  if (raw < 0 || raw > MAX_SEED) {
    return { ok: false, reason: `seed must be in [0, ${MAX_SEED}]` };
  }
  return { ok: true, value: raw };
}
