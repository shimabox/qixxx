// Which in-play hints (src/hints/) this device has already been shown,
// kept in localStorage as a JSON array of hint ids — the same best-effort
// persistence as src/storage/highscore.ts: every access is wrapped in
// try/catch, and a storage that cannot be read, holds a broken value or cannot
// be written never throws. It then starts with nothing seen, and the ids
// marked seen during this page load are still remembered in memory, so a
// hint is not repeated within one page load.
export const HINTS_SEEN_STORAGE_KEY = 'qixxx.hintsSeen';

/** The parts of the Web Storage API this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike {
  return localStorage;
}

export class HintSeenStore {
  private readonly getStorage: () => StorageLike;
  private readonly seen: Set<string>;

  /** `getStorage` defaults to localStorage; it may throw (no storage at all). */
  constructor(getStorage: () => StorageLike = defaultStorage) {
    this.getStorage = getStorage;
    this.seen = new Set(this.read());
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  markSeen(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    try {
      this.getStorage().setItem(HINTS_SEEN_STORAGE_KEY, JSON.stringify([...this.seen]));
    } catch {
      // Best-effort persistence only — the in-memory set still has it.
    }
  }

  /** Forgets every seen id, saved and in memory (the debug panel's RESET HINTS). */
  reset(): void {
    this.seen.clear();
    try {
      this.getStorage().removeItem(HINTS_SEEN_STORAGE_KEY);
    } catch {
      // Best-effort, as above.
    }
  }

  private read(): string[] {
    try {
      const raw = this.getStorage().getItem(HINTS_SEEN_STORAGE_KEY);
      if (raw === null) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }
}
