import { describe, it, expect } from 'vitest';
import { shouldPersistHighScore, resolveHudModePrefix } from './runMode';

describe('shouldPersistHighScore', () => {
  it('is true only for normal', () => {
    expect(shouldPersistHighScore('normal')).toBe(true);
    expect(shouldPersistHighScore('seeded')).toBe(false);
  });
});

describe('resolveHudModePrefix', () => {
  it('is empty for normal — byte-identical to pre-feature HUD text', () => {
    expect(resolveHudModePrefix('normal', { seededRunSeed: 42 })).toBe('');
  });

  it('shows SEED <n> for seeded', () => {
    expect(resolveHudModePrefix('seeded', { seededRunSeed: 42 })).toBe('SEED 42  ');
  });

  it('leads with EASY for an EASY run, before SEED <n> when both apply', () => {
    expect(resolveHudModePrefix('normal', { seededRunSeed: undefined, difficulty: 'easy' })).toBe('EASY  ');
    expect(resolveHudModePrefix('seeded', { seededRunSeed: 42, difficulty: 'easy' })).toBe('EASY  SEED 42  ');
    expect(resolveHudModePrefix('normal', { seededRunSeed: undefined, difficulty: 'normal' })).toBe('');
    expect(resolveHudModePrefix('seeded', { seededRunSeed: 42, difficulty: 'normal' })).toBe('SEED 42  ');
  });
});
