// vitest.config.ts runs the whole suite under Node (no jsdom), so there's no
// global `localStorage` by default — every test below stubs a tiny in-memory
// implementation first (mirroring what a real browser's localStorage looks
// like from these functions' perspective: string-keyed, string-valued,
// synchronous). The "storage unavailable" tests stub it to `undefined`
// instead, exercising the try/catch fallback path the module comment
// describes.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadBestTimes, loadBestTime, saveBestTimeIfBetter } from './bestTimes';

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

describe('bestTimes storage', () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it('loadBestTimes() returns {} when nothing has been saved yet', () => {
    expect(loadBestTimes()).toEqual({});
  });

  it('loadBestTime() returns null for a stage with no recorded best', () => {
    expect(loadBestTime(1)).toBeNull();
  });

  it('saveBestTimeIfBetter() records the first time for a stage and reports it as a new record', () => {
    expect(saveBestTimeIfBetter(1, 900)).toBe(true);
    expect(loadBestTime(1)).toBe(900);
  });

  it('saveBestTimeIfBetter() overwrites with a strictly lower (better) time and reports a new record', () => {
    saveBestTimeIfBetter(1, 900);
    expect(saveBestTimeIfBetter(1, 700)).toBe(true);
    expect(loadBestTime(1)).toBe(700);
  });

  it('saveBestTimeIfBetter() leaves a strictly higher (worse) time untouched and reports no new record', () => {
    saveBestTimeIfBetter(1, 700);
    expect(saveBestTimeIfBetter(1, 900)).toBe(false);
    expect(loadBestTime(1)).toBe(700);
  });

  it('saveBestTimeIfBetter() leaves an equal time untouched (strictly-better, not better-or-equal) and reports no new record', () => {
    saveBestTimeIfBetter(1, 700);
    expect(saveBestTimeIfBetter(1, 700)).toBe(false);
    expect(loadBestTime(1)).toBe(700);
  });

  it('tracks every stage independently under one JSON map', () => {
    saveBestTimeIfBetter(1, 600);
    saveBestTimeIfBetter(2, 1200);
    saveBestTimeIfBetter(3, 1800);
    expect(loadBestTimes()).toEqual({ 1: 600, 2: 1200, 3: 1800 });
  });

  it('floors a non-integer tick count before persisting', () => {
    saveBestTimeIfBetter(1, 123.9);
    expect(loadBestTime(1)).toBe(123);
  });

  it('drops malformed/out-of-range entries from a corrupted stored JSON blob without discarding the whole map', () => {
    localStorage.setItem(
      'qixxx.bestTimes',
      JSON.stringify({ '1': 500, notANumber: 999, '2': -5, '3': 'nope', '4': 1234 })
    );
    expect(loadBestTimes()).toEqual({ 1: 500, 4: 1234 });
  });

  it('falls back to {} / null / false without throwing when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadBestTimes()).toEqual({});
    expect(loadBestTime(1)).toBeNull();
    expect(saveBestTimeIfBetter(1, 100)).toBe(false);
  });
});
