import { describe, expect, it } from 'vitest';
import { PLAY_LOG_STORAGE_KEY, PlayLogStore } from './playLog';
import type { StorageLike } from './hints';
import type { PlayRecord } from '../playLog/record';
import { PLAY_LOG_MAX_RUNS } from '../config';

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

function run(score: number, overrides: Partial<PlayRecord> = {}): PlayRecord {
  return {
    endedAt: 1_700_000_000_000 + score,
    stage: 1,
    score,
    end: 'life',
    ticks: 600,
    stages: [{ stage: 1, claims: 3, splits: 0, misses: { wisp: 2, ember: 1, igniter: 0 }, cleared: false }],
    ...overrides,
  };
}

function stored(storage: MemoryStorage): unknown {
  const raw = storage.getItem(PLAY_LOG_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe('PlayLogStore', () => {
  it('saves the runs under qixxx.playLog as { v: 1, runs } and reads them back in the order added', () => {
    const storage = new MemoryStorage();
    const store = new PlayLogStore(() => storage);
    store.append(run(10));
    store.append(run(20));
    expect(store.list().map((r) => r.score)).toEqual([10, 20]);
    expect(stored(storage)).toEqual({ v: 1, runs: [run(10), run(20)] });
    expect(new PlayLogStore(() => storage).list()).toEqual([run(10), run(20)]);
  });

  it('keeps the newest 50: the 51st run drops the oldest', () => {
    const storage = new MemoryStorage();
    const store = new PlayLogStore(() => storage);
    for (let i = 1; i <= PLAY_LOG_MAX_RUNS; i++) store.append(run(i));
    expect(store.list()).toHaveLength(50);
    store.append(run(51));
    const scores = store.list().map((r) => r.score);
    expect(scores).toHaveLength(50);
    expect(scores[0]).toBe(2);
    expect(scores[49]).toBe(51);
    expect((stored(storage) as { runs: PlayRecord[] }).runs.map((r) => r.score)).toEqual(scores);
  });

  it('reads only the newest 50 of a longer stored list', () => {
    const storage = new MemoryStorage();
    const runs = Array.from({ length: 60 }, (_, i) => run(i + 1));
    storage.setItem(PLAY_LOG_STORAGE_KEY, JSON.stringify({ v: 1, runs }));
    const scores = new PlayLogStore(() => storage).list().map((r) => r.score);
    expect(scores).toHaveLength(50);
    expect(scores[0]).toBe(11);
    expect(scores[49]).toBe(60);
  });

  it.each([
    ['not JSON', '{not json'],
    ['another version', JSON.stringify({ v: 2, runs: [run(1)] })],
    ['runs not an array', JSON.stringify({ v: 1, runs: { 0: run(1) } })],
    ['an array', JSON.stringify([run(1)])],
    ['null', 'null'],
  ])('reads %s as no runs', (_name, raw) => {
    const storage = new MemoryStorage();
    storage.setItem(PLAY_LOG_STORAGE_KEY, raw);
    const store = new PlayLogStore(() => storage);
    expect(store.list()).toEqual([]);
    // The next run replaces it with a sound file.
    store.append(run(5));
    expect(stored(storage)).toEqual({ v: 1, runs: [run(5)] });
  });

  it('reads a missing key as no runs', () => {
    expect(new PlayLogStore(() => new MemoryStorage()).list()).toEqual([]);
  });

  it('drops only the stored runs that do not have the record shape', () => {
    const storage = new MemoryStorage();
    const good = run(7);
    const bad: unknown[] = [
      null,
      3,
      { ...run(1), score: '100' },
      { ...run(1), end: 'quit' },
      { ...run(1), stages: 'none' },
      { ...run(1), ticks: Number.NaN },
      { ...run(1), stages: [{ stage: 1, claims: 1, splits: 0, misses: { wisp: 1, ember: 0 }, cleared: false }] },
      { ...run(1), stages: [{ stage: 1, claims: 1, splits: 0, misses: { wisp: 1, ember: 0, igniter: 0 }, cleared: 'no' }] },
    ];
    storage.setItem(PLAY_LOG_STORAGE_KEY, JSON.stringify({ v: 1, runs: [bad[0], good, ...bad.slice(1), run(8)] }));
    expect(new PlayLogStore(() => storage).list()).toEqual([good, run(8)]);
  });

  it('keeps only the record fields of a stored run', () => {
    const storage = new MemoryStorage();
    storage.setItem(PLAY_LOG_STORAGE_KEY, JSON.stringify({ v: 1, runs: [{ ...run(3), seed: 42, extra: 'x' }] }));
    expect(new PlayLogStore(() => storage).list()).toEqual([run(3)]);
  });

  it('never throws on a storage that cannot be read or written, and keeps the runs in memory', () => {
    const store = new PlayLogStore(() => throwing);
    expect(store.list()).toEqual([]);
    expect(() => store.append(run(1))).not.toThrow();
    expect(() => store.append(run(2))).not.toThrow();
    expect(store.list().map((r) => r.score)).toEqual([1, 2]);
    expect(() => store.clear()).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  it('never throws when there is no storage at all', () => {
    const store = new PlayLogStore(() => {
      throw new Error('no localStorage');
    });
    expect(() => store.append(run(1))).not.toThrow();
    expect(store.list()).toHaveLength(1);
  });

  it('clear() removes the key', () => {
    const storage = new MemoryStorage();
    const store = new PlayLogStore(() => storage);
    store.append(run(1));
    store.clear();
    expect(storage.getItem(PLAY_LOG_STORAGE_KEY)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('list() and toFile() hand out copies', () => {
    const store = new PlayLogStore(() => new MemoryStorage());
    store.append(run(1));
    store.list()[0].stages[0].misses.wisp = 99;
    store.toFile().runs.pop();
    expect(store.toFile()).toEqual({ v: 1, runs: [run(1)] });
  });
});
