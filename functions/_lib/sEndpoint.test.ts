// GET /s, exercised through the REAL handler (functions/s.ts) with only the
// KV namespace stubbed.
import { describe, it, expect, vi } from 'vitest';
import { onRequestGet } from '../s';

const ORIGIN = 'https://qixxx.example';
const VALID_ID = '0123456789abcdef0123456789abcdef';

function makeEnv(records: Record<string, string> = {}) {
  const kv = {
    get: vi.fn(async (key: string) => records[key] ?? null),
    put: vi.fn(),
  };
  return { kv, env: { SHARES: kv, DB: {} } as unknown as Parameters<typeof onRequestGet>[0]['env'] };
}

async function call(id: string | null, env: ReturnType<typeof makeEnv>['env']) {
  const url = id === null ? `${ORIGIN}/s` : `${ORIGIN}/s?id=${encodeURIComponent(id)}`;
  const request = new Request(url, { method: 'GET' });
  return onRequestGet({ request, env, waitUntil: vi.fn() } as unknown as Parameters<typeof onRequestGet>[0]);
}

describe('GET /s id gate', () => {
  it('404s without a KV read for anything that is not a share id', async () => {
    const { env, kv } = makeEnv();
    for (const id of [null, '', 'abc', VALID_ID.toUpperCase(), 'x'.repeat(600)]) {
      const response = await call(id, env);
      expect(response.status).toBe(404);
    }
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('404s for a well-formed but unknown id (one KV read)', async () => {
    const { env, kv } = makeEnv();
    const response = await call(VALID_ID, env);
    expect(response.status).toBe(404);
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith(`share:${VALID_ID}`);
  });

  it('renders the OG page for a known id', async () => {
    const { env } = makeEnv({ [`share:${VALID_ID}`]: JSON.stringify({ score: 1234, stage: 3, hi: 5678, at: 0 }) });
    const response = await call(VALID_ID, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    const html = await response.text();
    expect(html).toContain(`${ORIGIN}/og?id=${VALID_ID}`);
    expect(html).toContain('SCORE 1,234');
    expect(html).toContain('STAGE 3 / HI 5,678');
  });
});
