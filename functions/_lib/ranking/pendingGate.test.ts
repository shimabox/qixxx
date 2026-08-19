import { describe, it, expect } from 'vitest';
import { getVerifiedTenthPlaceThreshold, isWithinProvisionalRange, PENDING_EXPIRY_MS } from './pendingGate';

describe('isWithinProvisionalRange', () => {
  it('is true when score strictly exceeds the threshold', () => {
    expect(isWithinProvisionalRange(101, 100)).toBe(true);
  });

  it('is false for a tie (spec: a tie is out of range, not in)', () => {
    expect(isWithinProvisionalRange(100, 100)).toBe(false);
  });

  it('is false when score is below the threshold', () => {
    expect(isWithinProvisionalRange(50, 100)).toBe(false);
  });

  it('is unconditionally true for the COALESCE(...,-1) boundary (fewer than 10 verified rows)', () => {
    expect(isWithinProvisionalRange(0, -1)).toBe(true);
  });
});

describe('PENDING_EXPIRY_MS', () => {
  it('is exactly 24 hours', () => {
    expect(PENDING_EXPIRY_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('getVerifiedTenthPlaceThreshold', () => {
  function makeEnv(threshold: number) {
    const queries: { sql: string; args: unknown[] }[] = [];
    return {
      env: {
        DB: {
          prepare: (sql: string) => ({
            bind: (...args: unknown[]) => {
              queries.push({ sql, args });
              return { first: async () => ({ threshold }) };
            },
          }),
        },
      } as unknown as import('../types').Env,
      queries,
    };
  }

  it('returns the value the SELECT reports', async () => {
    const { env } = makeEnv(4242);
    expect(await getVerifiedTenthPlaceThreshold(env, 1, 1)).toBe(4242);
  });

  it('binds seasonId/rulesetVersion in order', async () => {
    const { env, queries } = makeEnv(-1);
    await getVerifiedTenthPlaceThreshold(env, 7, 3);
    expect(queries[0].args).toEqual([7, 3]);
  });

  it('queries only verified rows (status filter present in SQL)', async () => {
    const { env, queries } = makeEnv(-1);
    await getVerifiedTenthPlaceThreshold(env, 1, 1);
    expect(queries[0].sql).toMatch(/status\s*=\s*'verified'/);
  });

  it('falls back to -1 if the query somehow returns no row at all', async () => {
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as unknown as import('../types').Env;
    expect(await getVerifiedTenthPlaceThreshold(env, 1, 1)).toBe(-1);
  });
});
