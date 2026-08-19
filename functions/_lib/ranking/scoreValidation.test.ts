import { describe, it, expect } from 'vitest';
import { validateScore, validateStage, MAX_SCORE, MAX_STAGE } from './scoreValidation';

describe('validateScore', () => {
  it('accepts 0 (the minimum)', () => {
    expect(validateScore(0)).toEqual({ ok: true, value: 0 });
  });

  it('accepts MAX_SCORE', () => {
    expect(validateScore(MAX_SCORE)).toEqual({ ok: true, value: MAX_SCORE });
  });

  it('rejects a negative score', () => {
    expect(validateScore(-1).ok).toBe(false);
  });

  it('rejects a score past MAX_SCORE', () => {
    expect(validateScore(MAX_SCORE + 1).ok).toBe(false);
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

  it('accepts MAX_STAGE', () => {
    expect(validateStage(MAX_STAGE)).toEqual({ ok: true, value: MAX_STAGE });
  });

  it('rejects 0 (stage must be >= 1)', () => {
    expect(validateStage(0).ok).toBe(false);
  });

  it('rejects a negative stage', () => {
    expect(validateStage(-1).ok).toBe(false);
  });

  it('rejects a stage past MAX_STAGE', () => {
    expect(validateStage(MAX_STAGE + 1).ok).toBe(false);
  });

  it('rejects a non-integer stage', () => {
    expect(validateStage(2.5).ok).toBe(false);
  });
});
