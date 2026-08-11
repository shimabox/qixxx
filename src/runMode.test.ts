// Regression coverage for the 2026-08-11 cross-review fix: an arbitrary
// `?seed=<n>` run started by a normal key/tap must be classified 'seeded',
// never 'daily' — see runMode.ts's module comment for the full rationale.
import { describe, it, expect } from 'vitest';
import {
  RunMode,
  shouldPersistHighScore,
  shouldPersistDailyBest,
  shouldPersistBestTime,
  resolveTitleConfirmRunMode,
  resolveDisplayHighScore,
  resolveHudModePrefix,
} from './runMode';

const ALL_MODES: RunMode[] = ['normal', 'seeded', 'daily'];

describe('shouldPersistHighScore', () => {
  it('is true only for normal', () => {
    expect(shouldPersistHighScore('normal')).toBe(true);
    expect(shouldPersistHighScore('seeded')).toBe(false);
    expect(shouldPersistHighScore('daily')).toBe(false);
  });
});

describe('shouldPersistDailyBest', () => {
  it('is true only for daily — the core cross-review guarantee', () => {
    expect(shouldPersistDailyBest('daily')).toBe(true);
    expect(shouldPersistDailyBest('seeded')).toBe(false);
    expect(shouldPersistDailyBest('normal')).toBe(false);
  });
});

describe('shouldPersistBestTime', () => {
  it('is true only for normal (both seeded and daily boards are non-standard)', () => {
    expect(shouldPersistBestTime('normal')).toBe(true);
    expect(shouldPersistBestTime('seeded')).toBe(false);
    expect(shouldPersistBestTime('daily')).toBe(false);
  });
});

describe('resolveTitleConfirmRunMode', () => {
  it('leaves a normal run normal, regardless of ?seed= presence', () => {
    expect(resolveTitleConfirmRunMode('normal', undefined)).toBe('normal');
    expect(resolveTitleConfirmRunMode('normal', 42)).toBe('normal');
  });

  it('leaves a seeded run seeded, regardless of ?seed= presence (GameSession itself reuses the seed on retry)', () => {
    expect(resolveTitleConfirmRunMode('seeded', undefined)).toBe('seeded');
    expect(resolveTitleConfirmRunMode('seeded', 42)).toBe('seeded');
  });

  it('falls a daily run back to normal when no ?seed= pinned the page load', () => {
    expect(resolveTitleConfirmRunMode('daily', undefined)).toBe('normal');
  });

  it('falls a daily run back to seeded (not normal) when ?seed= pinned the page load', () => {
    expect(resolveTitleConfirmRunMode('daily', 42)).toBe('seeded');
  });

  it('never returns daily for any input — only clicking the DAILY button can start one', () => {
    for (const mode of ALL_MODES) {
      expect(resolveTitleConfirmRunMode(mode, undefined)).not.toBe('daily');
      expect(resolveTitleConfirmRunMode(mode, 42)).not.toBe('daily');
    }
  });
});

describe('resolveDisplayHighScore', () => {
  it('shows the DAILY best (vs. the current run score) for daily, ignoring qixxx.highScore entirely', () => {
    expect(
      resolveDisplayHighScore('daily', { dailyBestAtRunStart: 500, currentScore: 300, sessionHighScore: 9999 })
    ).toBe(500);
    expect(
      resolveDisplayHighScore('daily', { dailyBestAtRunStart: 500, currentScore: 800, sessionHighScore: 9999 })
    ).toBe(800);
  });

  it('shows the ordinary session high score for seeded, ignoring the DAILY best entirely', () => {
    expect(
      resolveDisplayHighScore('seeded', { dailyBestAtRunStart: 999999, currentScore: 0, sessionHighScore: 1234 })
    ).toBe(1234);
  });

  it('shows the ordinary session high score for normal', () => {
    expect(
      resolveDisplayHighScore('normal', { dailyBestAtRunStart: 0, currentScore: 0, sessionHighScore: 777 })
    ).toBe(777);
  });
});

describe('resolveHudModePrefix', () => {
  it('is empty for normal — byte-identical to pre-feature HUD text', () => {
    expect(resolveHudModePrefix('normal', { dailyDateStr: '2026-08-11', seededRunSeed: 42 })).toBe('');
  });

  it('shows DAILY <date> for daily', () => {
    expect(resolveHudModePrefix('daily', { dailyDateStr: '2026-08-11', seededRunSeed: undefined })).toBe(
      'DAILY 2026-08-11  '
    );
  });

  it('shows SEED <n> for seeded — never DAILY <date>, the exact mislabeling the cross-review flagged', () => {
    const prefix = resolveHudModePrefix('seeded', { dailyDateStr: '2026-08-11', seededRunSeed: 42 });
    expect(prefix).toBe('SEED 42  ');
    expect(prefix).not.toContain('DAILY');
  });
});
