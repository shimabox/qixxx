// Pure parsing logic for the `?seed=<number>` URL parameter (main.ts's
// SEEDED RUNS / TIME ATTACK feature). Kept as a standalone, DOM-free module
// — like runMode.ts — specifically so this has direct unit test coverage
// without needing a jsdom environment; main.ts calls it with the raw
// query-string value read via
// `new URLSearchParams(window.location.search).get('seed')`.

/**
 * Parses the raw `?seed=` query value into a seed, or `undefined` if the
 * parameter is absent or not a finite number.
 *
 * Rounds the result to an unsigned 32-bit integer (`>>> 0`, after
 * `Math.floor` so a fractional input like `1.5` still floors to `1` first,
 * matching this function's pre-existing behavior) — P3 fix (user review,
 * 2026-08-12): an arbitrarily large finite seed (e.g.
 * `?seed=9007199254740991`) used to be threaded through unclamped.
 * GameSession's own `deriveStageSeed()`/`hashString()` (core/rng.ts) still
 * hash such a value's decimal string form without erroring, but the HUD's
 * `SEED <n>` display (390px, 3-line mode) then didn't fit and clipped the
 * TIME field next to it, and the displayed value no longer read as an
 * obviously reproducible/shareable number. Clamping to an unsigned 32-bit
 * integer here — the same width `mulberry32` (core/rng.ts) already
 * truncates its internal state to — keeps the value bounded to at most 10
 * digits and makes "the seed you see is the seed you'd re-enter" hold
 * exactly.
 */
export function parseSeedParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n) >>> 0;
}
