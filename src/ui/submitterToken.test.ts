// Client-side submitter token: the generator's format and randomness source, the
// localStorage round trip, and every "storage is unusable" path falling back
// to no token at all rather than failing the submission.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateSubmitterToken,
  getOrCreateSubmitterToken,
  SUBMITTER_TOKEN_PATTERN,
  SUBMITTER_TOKEN_BYTES,
  SUBMITTER_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from './submitterToken';

/** An in-memory localStorage stand-in — vitest runs in the `node` environment here (vitest.config.ts), where there is no real one. */
function memoryStorage(initial: Record<string, string> = {}): TokenStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateSubmitterToken', () => {
  it('produces exactly 32 lowercase hex characters (= 16 bytes)', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateSubmitterToken();
      expect(token).toMatch(SUBMITTER_TOKEN_PATTERN);
      expect(token).toHaveLength(SUBMITTER_TOKEN_BYTES * 2);
      expect(token).toBe(token.toLowerCase());
    }
  });

  // The server stores an UNKEYED hash of this value, and the only thing
  // making that safe is that the value is 128 bits of CSPRNG output. A
  // Math.random()-based generator would pass the format check above while
  // quietly making submitter_hash guessable — i.e. making OTHER players'
  // pending rows deletable. Pinned to the actual API, not just the shape.
  it('draws its 16 bytes from crypto.getRandomValues()', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    generateSubmitterToken();
    expect(spy).toHaveBeenCalledTimes(1);
    const filled = spy.mock.calls[0][0] as ArrayBufferView;
    expect(filled).toBeInstanceOf(Uint8Array);
    expect(filled.byteLength).toBe(SUBMITTER_TOKEN_BYTES);
  });

  it('renders every byte as two hex digits, low bytes included (no dropped leading zeros)', () => {
    // 0x00 and 0x0f must become "00"/"0f", not "0"/"f" — a toString(16)
    // without padStart yields a short, malformed token the server 400s.
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array: ArrayBufferView) => {
      new Uint8Array(array.buffer).fill(0x0f);
      return array;
    });
    expect(generateSubmitterToken()).toBe('0f'.repeat(16));
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSubmitterToken()));
    expect(seen.size).toBe(200);
  });
});

describe('generateSubmitterToken / server agreement', () => {
  // src/ cannot import from functions/ — separate tsconfig projects, and
  // pulling server code into the browser bundle would be wrong anyway — so
  // the wire format is pinned to a LITERAL here, and to the same literal in
  // functions/_lib/ranking/submitterToken.test.ts. Either side drifting
  // breaks its own test rather than silently 400-ing every real submission.
  it('emits tokens matching the exact pattern the server validates against', () => {
    expect(SUBMITTER_TOKEN_PATTERN.source).toBe('^[0-9a-f]{32}$');
    for (let i = 0; i < 20; i++) {
      expect(new RegExp('^[0-9a-f]{32}$').test(generateSubmitterToken())).toBe(true);
    }
  });
});

describe('getOrCreateSubmitterToken', () => {
  it('mints and persists a token on first use', () => {
    const storage = memoryStorage();
    const token = getOrCreateSubmitterToken(storage);
    expect(token).toMatch(SUBMITTER_TOKEN_PATTERN);
    expect(storage.data[SUBMITTER_TOKEN_STORAGE_KEY]).toBe(token);
  });

  // The reason the token is persisted at all: a per-page-load token would let
  // a reloading player pile up pending rows they can no longer replace,
  // burning their own IP quota. This is the vitest-level half of the E2E
  // reload test.
  it('reuses the SAME token on every later call, including across a fresh module call with the same storage', () => {
    const storage = memoryStorage();
    const first = getOrCreateSubmitterToken(storage);
    expect(getOrCreateSubmitterToken(storage)).toBe(first);
    expect(getOrCreateSubmitterToken(memoryStorage(storage.data))).toBe(first);
  });

  it('replaces a stored value that is not in the wire format, rather than sending one the server would 400', () => {
    for (const corrupt of ['', 'not-a-token', '0123456789ABCDEF0123456789ABCDEF', '0'.repeat(31)]) {
      const storage = memoryStorage({ [SUBMITTER_TOKEN_STORAGE_KEY]: corrupt });
      const token = getOrCreateSubmitterToken(storage);
      expect(token).toMatch(SUBMITTER_TOKEN_PATTERN);
      expect(storage.data[SUBMITTER_TOKEN_STORAGE_KEY]).toBe(token);
    }
  });

  it('returns null when there is no storage at all (private browsing), so the submission simply goes out token-less', () => {
    expect(getOrCreateSubmitterToken(null)).toBeNull();
  });

  it('returns null — never throws — when getItem throws (storage blocked mid-session)', () => {
    const storage: TokenStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    expect(getOrCreateSubmitterToken(storage)).toBeNull();
  });

  it('returns null when setItem throws (quota exceeded)', () => {
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(getOrCreateSubmitterToken(storage)).toBeNull();
  });
});
