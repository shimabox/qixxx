import { describe, it, expect } from 'vitest';
import { validateSharePayload } from './validation';
import { maxScoreForStage } from './scoreLimits';

describe('validateSharePayload', () => {
  it('accepts a well-formed payload', () => {
    const result = validateSharePayload({ score: 1000, stage: 3, hi: 1000 });
    expect(result).toEqual({ kind: 'ok', value: { score: 1000, stage: 3, hi: 1000 } });
  });

  it('accepts hi strictly greater than score (a past run set the high score)', () => {
    const result = validateSharePayload({ score: 500, stage: 1, hi: 9000 });
    expect(result.kind).toBe('ok');
  });

  it.each([
    [null],
    [undefined],
    ['a string'],
    [42],
    [[1, 2, 3]],
  ])('rejects a non-object body: %j', (body) => {
    const result = validateSharePayload(body);
    expect(result.kind).toBe('malformed');
  });

  it.each([
    [{ score: -1, stage: 1, hi: 0 }],
    [{ score: 1.5, stage: 1, hi: 2 }],
    [{ score: '100', stage: 1, hi: 100 }],
    [{ stage: 1, hi: 100 }],
  ])('rejects an invalid score: %j', (body) => {
    expect(validateSharePayload(body).kind).toBe('malformed');
  });

  it.each([
    [{ score: 0, stage: 0, hi: 0 }],
    [{ score: 0, stage: -1, hi: 0 }],
    [{ score: 0, stage: 1.5, hi: 0 }],
    [{ score: 0, hi: 0 }],
  ])('rejects an invalid stage: %j', (body) => {
    expect(validateSharePayload(body).kind).toBe('malformed');
  });

  it.each([
    [{ score: 0, stage: 1, hi: -1 }],
    [{ score: 100, stage: 1, hi: 50 }], // hi < score
    [{ score: 0, stage: 1 }],
  ])('rejects an invalid hi: %j', (body) => {
    expect(validateSharePayload(body).kind).toBe('malformed');
  });

  it('rejects a score exceeding the theoretical max for the given stage', () => {
    const ceiling = maxScoreForStage(1);
    const result = validateSharePayload({ score: ceiling + 1, stage: 1, hi: ceiling + 1 });
    expect(result.kind).toBe('exceeds-max');
  });

  it('accepts a score exactly at the theoretical max for the given stage', () => {
    const ceiling = maxScoreForStage(1);
    const result = validateSharePayload({ score: ceiling, stage: 1, hi: ceiling });
    expect(result.kind).toBe('ok');
  });
});
