// See bestTimes.test.ts's module comment for why every test stubs a tiny
// in-memory localStorage first (vitest.config.ts runs under Node, no jsdom).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getJstDateString, loadDailyBest, saveDailyBestIfBetter, cleanupOldDailyKeys } from './daily';
import { loadHighScore, saveHighScore } from './highscore';

function installMockLocalStorage(): void {
  const store = new Map<string, string>();
  const mock: Storage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', mock);
}

describe('getJstDateString', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(getJstDateString(new Date('2026-08-11T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses JST (UTC+9), not the machine/browser local timezone or plain UTC', () => {
    // 2026-08-11T16:00:00Z is 2026-08-12 01:00 JST — a UTC calendar date
    // (still the 11th) that has already rolled to the 12th in JST. Any
    // implementation that used UTC (or a non-JST local zone) directly would
    // report "2026-08-11" here instead.
    expect(getJstDateString(new Date('2026-08-11T16:00:00Z'))).toBe('2026-08-12');
  });

  it("stays on the earlier date for a time just before JST's midnight boundary", () => {
    // 2026-08-11T14:59:59Z is 2026-08-11 23:59:59 JST — one second before
    // the JST day rolls over.
    expect(getJstDateString(new Date('2026-08-11T14:59:59Z'))).toBe('2026-08-11');
  });

  it("rolls to the next date exactly at JST's midnight boundary", () => {
    // 2026-08-11T15:00:00Z is 2026-08-12 00:00:00 JST.
    expect(getJstDateString(new Date('2026-08-11T15:00:00Z'))).toBe('2026-08-12');
  });

  it('defaults to the current time when no date is given', () => {
    expect(() => getJstDateString()).not.toThrow();
  });
});

describe('daily best score storage', () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it('loadDailyBest() returns 0 for a date with nothing recorded yet', () => {
    expect(loadDailyBest('2026-08-11')).toBe(0);
  });

  it('saveDailyBestIfBetter() records the first score for a date and reports a new record', () => {
    expect(saveDailyBestIfBetter('2026-08-11', 500)).toBe(true);
    expect(loadDailyBest('2026-08-11')).toBe(500);
  });

  it('saveDailyBestIfBetter() overwrites with a strictly higher (better) score and reports a new record', () => {
    saveDailyBestIfBetter('2026-08-11', 500);
    expect(saveDailyBestIfBetter('2026-08-11', 800)).toBe(true);
    expect(loadDailyBest('2026-08-11')).toBe(800);
  });

  it('saveDailyBestIfBetter() leaves a strictly lower (worse) or equal score untouched and reports no new record', () => {
    saveDailyBestIfBetter('2026-08-11', 800);
    expect(saveDailyBestIfBetter('2026-08-11', 500)).toBe(false);
    expect(saveDailyBestIfBetter('2026-08-11', 800)).toBe(false);
    expect(loadDailyBest('2026-08-11')).toBe(800);
  });

  it('stores each date under its own key, independent of every other date', () => {
    saveDailyBestIfBetter('2026-08-10', 300);
    saveDailyBestIfBetter('2026-08-11', 700);
    expect(loadDailyBest('2026-08-10')).toBe(300);
    expect(loadDailyBest('2026-08-11')).toBe(700);
  });

  it("uses the documented qixxx.daily.<YYYY-MM-DD>.best key format", () => {
    saveDailyBestIfBetter('2026-08-11', 42);
    expect(localStorage.getItem('qixxx.daily.2026-08-11.best')).toBe('42');
  });

  it('never reads or writes the ordinary qixxx.highScore key (no cross-contamination)', () => {
    saveHighScore(999);
    saveDailyBestIfBetter('2026-08-11', 12345);
    // The ordinary high score is completely unaffected by a daily save...
    expect(loadHighScore()).toBe(999);
    // ...and vice versa: an ordinary high-score save never touches a daily key.
    saveHighScore(1); // lower — a no-op write path, but still shouldn't touch daily
    expect(loadDailyBest('2026-08-11')).toBe(12345);
  });

  it('falls back to 0 / false without throwing when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadDailyBest('2026-08-11')).toBe(0);
    expect(saveDailyBestIfBetter('2026-08-11', 100)).toBe(false);
  });
});

describe('cleanupOldDailyKeys', () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it("removes every daily best key except today's", () => {
    saveDailyBestIfBetter('2026-08-09', 100);
    saveDailyBestIfBetter('2026-08-10', 200);
    saveDailyBestIfBetter('2026-08-11', 300);

    cleanupOldDailyKeys('2026-08-11');

    expect(loadDailyBest('2026-08-09')).toBe(0);
    expect(loadDailyBest('2026-08-10')).toBe(0);
    expect(loadDailyBest('2026-08-11')).toBe(300); // kept
  });

  it('never removes unrelated keys (e.g. the ordinary high score or the best-times map)', () => {
    saveHighScore(555);
    localStorage.setItem('qixxx.bestTimes', JSON.stringify({ 1: 600 }));
    saveDailyBestIfBetter('2026-08-10', 200);

    cleanupOldDailyKeys('2026-08-11'); // no daily key for the 11th exists yet

    expect(loadHighScore()).toBe(555);
    expect(localStorage.getItem('qixxx.bestTimes')).toBe(JSON.stringify({ 1: 600 }));
  });

  it('is a no-op (does not throw) when no daily keys exist at all', () => {
    expect(() => cleanupOldDailyKeys('2026-08-11')).not.toThrow();
  });

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => cleanupOldDailyKeys('2026-08-11')).not.toThrow();
  });
});
