import { describe, it, expect } from 'vitest';
import { validateScore, validateStage } from './scoreValidation';

describe('validateScore', () => {
  it('accepts 0 (the minimum)', () => {
    expect(validateScore(0)).toEqual({ ok: true, value: 0 });
  });

  // The bug this replaced: score was capped at 999_999, a number taken from
  // src/config.ts's HUD sizing budget — whose own comment names a 7+-digit
  // cumulative score as an accepted residual, i.e. a reachable one. A
  // legitimate 7-digit run was therefore rejected with a 400 before the
  // audit could ever confirm it.
  it('accepts a 7-digit score (the game itself treats one as reachable — no display-derived cap here)', () => {
    expect(validateScore(1_000_000)).toEqual({ ok: true, value: 1_000_000 });
    expect(validateScore(9_999_999)).toEqual({ ok: true, value: 9_999_999 });
  });

  it('accepts an absurdly large but still safe-integer claim (the audit, not this layer, is what rejects it)', () => {
    expect(validateScore(9e15)).toEqual({ ok: true, value: 9e15 });
    expect(validateScore(Number.MAX_SAFE_INTEGER)).toEqual({ ok: true, value: Number.MAX_SAFE_INTEGER });
  });

  it('rejects a negative score', () => {
    expect(validateScore(-1).ok).toBe(false);
  });

  it('rejects a value past the safe-integer range (not an exact integer claim at all)', () => {
    expect(validateScore(Number.MAX_SAFE_INTEGER + 2).ok).toBe(false);
    expect(validateScore(1e300).ok).toBe(false);
  });

  it('rejects a non-integer score', () => {
    expect(validateScore(1.5).ok).toBe(false);
  });

  it('rejects NaN/Infinity', () => {
    expect(validateScore(NaN).ok).toBe(false);
    expect(validateScore(Infinity).ok).toBe(false);
  });

  it('rejects a non-number', () => {
    expect(validateScore('100').ok).toBe(false);
    expect(validateScore(undefined).ok).toBe(false);
    expect(validateScore(null).ok).toBe(false);
  });
});

describe('validateStage', () => {
  it('accepts 1 (the minimum)', () => {
    expect(validateStage(1)).toEqual({ ok: true, value: 1 });
  });

  // Same fix as validateScore's: core/stage.ts's difficulty curve plateaus
  // and holds flat forever, so nothing in the simulation bounds how many
  // stages a long run clears — the old MAX_STAGE=999 was, again, only the
  // HUD's 3-digit display budget.
  it('accepts a 4-digit stage (nothing in core/ bounds the stage count)', () => {
    expect(validateStage(1000)).toEqual({ ok: true, value: 1000 });
  });

  it('rejects 0 (stage must be >= 1)', () => {
    expect(validateStage(0).ok).toBe(false);
  });

  it('rejects a negative stage', () => {
    expect(validateStage(-1).ok).toBe(false);
  });

  it('rejects a value past the safe-integer range', () => {
    expect(validateStage(Number.MAX_SAFE_INTEGER + 2).ok).toBe(false);
  });

  it('rejects a non-integer stage', () => {
    expect(validateStage(2.5).ok).toBe(false);
  });

  it('rejects NaN/Infinity and non-numbers', () => {
    expect(validateStage(NaN).ok).toBe(false);
    expect(validateStage(Infinity).ok).toBe(false);
    expect(validateStage('1').ok).toBe(false);
  });
});
