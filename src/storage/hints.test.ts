import { describe, expect, it } from 'vitest';
import { HINTS_SEEN_STORAGE_KEY, HintSeenStore, type StorageLike } from './hints';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('HintSeenStore', () => {
  it('saves the seen ids as a JSON array under qixxx.hintsSeen and reads them back', () => {
    const storage = new MemoryStorage();
    const store = new HintSeenStore(() => storage);
    expect(store.has('draw')).toBe(false);
    store.markSeen('draw');
    store.markSeen('ember');
    store.markSeen('draw');
    expect(JSON.parse(storage.getItem(HINTS_SEEN_STORAGE_KEY)!)).toEqual(['draw', 'ember']);
    const reloaded = new HintSeenStore(() => storage);
    expect(reloaded.has('draw')).toBe(true);
    expect(reloaded.has('ember')).toBe(true);
    expect(reloaded.has('slow')).toBe(false);
  });

  it('starts with nothing seen for a broken value', () => {
    for (const raw of ['not json', '{"draw":true}', '"draw"', '[1, null]', 'null', '']) {
      const storage = new MemoryStorage();
      storage.setItem(HINTS_SEEN_STORAGE_KEY, raw);
      const store = new HintSeenStore(() => storage);
      expect(store.has('draw'), raw).toBe(false);
    }
  });

  it('keeps only the string ids of a partly broken array', () => {
    const storage = new MemoryStorage();
    storage.setItem(HINTS_SEEN_STORAGE_KEY, '["split", 3, null, "igniter"]');
    const store = new HintSeenStore(() => storage);
    expect(store.has('split')).toBe(true);
    expect(store.has('igniter')).toBe(true);
  });

  it('does not throw when the storage cannot be read or written, and remembers in memory', () => {
    const store = new HintSeenStore(() => throwing);
    expect(store.has('draw')).toBe(false);
    expect(() => store.markSeen('draw')).not.toThrow();
    expect(store.has('draw')).toBe(true);
    expect(() => store.reset()).not.toThrow();
    expect(store.has('draw')).toBe(false);
  });

  it('does not throw when there is no storage at all', () => {
    const store = new HintSeenStore(() => {
      throw new ReferenceError('localStorage is not defined');
    });
    expect(store.has('draw')).toBe(false);
    store.markSeen('slow');
    expect(store.has('slow')).toBe(true);
  });

  it('remembers in memory when only writing fails', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('quota');
    };
    const store = new HintSeenStore(() => storage);
    store.markSeen('claimSide');
    expect(store.has('claimSide')).toBe(true);
  });

  it('reset() forgets the saved and the in-memory ids', () => {
    const storage = new MemoryStorage();
    const store = new HintSeenStore(() => storage);
    store.markSeen('draw');
    store.reset();
    expect(store.has('draw')).toBe(false);
    expect(storage.getItem(HINTS_SEEN_STORAGE_KEY)).toBeNull();
    expect(new HintSeenStore(() => storage).has('draw')).toBe(false);
  });
});
