import { describe, it, expect } from 'vitest';
import { shouldPersistHighScore, shouldPersistBestTime, resolveHudModePrefix } from './runMode';

describe('shouldPersistHighScore', () => {
  it('is true only for normal', () => {
    expect(shouldPersistHighScore('normal')).toBe(true);
    expect(shouldPersistHighScore('seeded')).toBe(false);
  });
});

describe('shouldPersistBestTime', () => {
  it('is true only for normal (a seeded board is non-standard)', () => {
    expect(shouldPersistBestTime('normal')).toBe(true);
    expect(shouldPersistBestTime('seeded')).toBe(false);
  });
});

describe('resolveHudModePrefix', () => {
  it('is empty for normal — byte-identical to pre-feature HUD text', () => {
    expect(resolveHudModePrefix('normal', { seededRunSeed: 42 })).toBe('');
  });

  it('shows SEED <n> for seeded', () => {
    expect(resolveHudModePrefix('seeded', { seededRunSeed: 42 })).toBe('SEED 42  ');
  });
});
