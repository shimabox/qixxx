import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDifficulty, saveDifficulty } from './settings';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Title screen difficulty setting', () => {
  it('is NORMAL until a choice is saved, then reads back what was saved under qixxx.difficulty', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(loadDifficulty()).toBe('normal');
    saveDifficulty('easy');
    expect(storage.getItem('qixxx.difficulty')).toBe('easy');
    expect(loadDifficulty()).toBe('easy');
    saveDifficulty('normal');
    expect(loadDifficulty()).toBe('normal');
  });

  it('reads anything else stored there as NORMAL', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    for (const value of ['', 'EASY', 'hard', '1', 'null']) {
      storage.setItem('qixxx.difficulty', value);
      expect(loadDifficulty(), value).toBe('normal');
    }
  });

  it('runs as NORMAL, without throwing, when storage is unavailable', () => {
    const fail = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { ...memoryStorage(), getItem: fail, setItem: fail });
    expect(loadDifficulty()).toBe('normal');
    expect(() => saveDifficulty('easy')).not.toThrow();
    expect(loadDifficulty()).toBe('normal');
  });
});
