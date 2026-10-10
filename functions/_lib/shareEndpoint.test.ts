// POST /share, exercised through the REAL handler (functions/share.ts) with
// only the KV namespace stubbed. Lives beside the other _lib tests rather
// than in functions/ itself, which is a Pages Functions route directory.
import { describe, it, expect, vi } from 'vitest';
import { onRequestPost, MAX_BODY_BYTES } from '../share';
import { RATE_LIMIT_MAX_REQUESTS } from './kv';
import { computeIpHash } from './ranking/ipHash';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'test-hmac-key-do-not-use-in-prod';
const IP = '203.0.113.1';

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function makeEnv(opts: { ipHashKey?: string | undefined } = {}) {
  const kv = makeKv();
  return {
    kv,
    env: { SHARES: kv, DB: {}, RANKING_IP_HASH_KEY: 'ipHashKey' in opts ? opts.ipHashKey : IP_HASH_KEY } as unknown as Parameters<typeof onRequestPost>[0]['env'],
  };
}

function makeRequest(body: string | ReadableStream<Uint8Array> | null, headers: Record<string, string | null> = {}): Request {
  const merged: Record<string, string> = { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': IP };
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return new Request(`${SELF_ORIGIN}/share`, {
    method: 'POST',
    headers: merged,
    body,
    ...(typeof body === 'string' || body === null ? {} : { duplex: 'half' }),
  } as RequestInit);
}

async function call(request: Request, env: ReturnType<typeof makeEnv>['env']) {
  const waitUntil = vi.fn();
  const response = await onRequestPost({ request, env, waitUntil } as unknown as Parameters<typeof onRequestPost>[0]);
  return { response, json: await response.json() as Record<string, unknown> };
}

const VALID_BODY = JSON.stringify({ score: 100, stage: 2, hi: 100 });

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe('POST /share header gates (run before any KV access)', () => {
  it('403 on missing or mismatched Origin, touching nothing', async () => {
    const { env, kv } = makeEnv();
    for (const origin of [null, 'https://evil.example']) {
      const { response } = await call(makeRequest(VALID_BODY, { Origin: origin }), env);
      expect(response.status).toBe(403);
    }
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('415 on a non-JSON Content-Type', async () => {
    const { env, kv } = makeEnv();
    const { response } = await call(makeRequest(VALID_BODY, { 'Content-Type': 'text/plain' }), env);
    expect(response.status).toBe(415);
    const missing = await call(makeRequest(VALID_BODY, { 'Content-Type': null }), env);
    expect(missing.response.status).toBe(415);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('413 early when Content-Length already exceeds the cap', async () => {
    const { env, kv } = makeEnv();
    const { response } = await call(makeRequest(VALID_BODY, { 'Content-Length': String(MAX_BODY_BYTES + 1) }), env);
    expect(response.status).toBe(413);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('500 (fail-closed) when RANKING_IP_HASH_KEY is missing or empty, touching nothing', async () => {
    for (const key of [undefined, '']) {
      const { env, kv } = makeEnv({ ipHashKey: key });
      const { response } = await call(makeRequest(VALID_BODY), env);
      expect(response.status).toBe(500);
      expect(kv.get).not.toHaveBeenCalled();
      expect(kv.put).not.toHaveBeenCalled();
    }
  });
});

describe('POST /share rate limit (consumed before the body is read)', () => {
  it('keys the KV counter on the ip_hash, never the raw IP', async () => {
    const { env, kv } = makeEnv();
    const { response } = await call(makeRequest(VALID_BODY), env);
    expect(response.status).toBe(200);
    const expectedHash = await computeIpHash(IP, IP_HASH_KEY);
    const rateKeys = [...kv.store.keys()].filter((k) => k.startsWith('ratelimit:'));
    expect(rateKeys).toHaveLength(1);
    expect(rateKeys[0]).toMatch(new RegExp(`^ratelimit:${expectedHash}:\\d+$`));
    for (const key of kv.store.keys()) expect(key).not.toContain(IP);
  });

  it('shares one counter across every address in an IPv6 /64', async () => {
    const { env, kv } = makeEnv();
    await call(makeRequest(VALID_BODY, { 'CF-Connecting-IP': '2001:db8:1:2:aaaa::1' }), env);
    await call(makeRequest(VALID_BODY, { 'CF-Connecting-IP': '2001:db8:1:2:bbbb::2' }), env);
    const rateKeys = [...kv.store.keys()].filter((k) => k.startsWith('ratelimit:'));
    expect(rateKeys).toHaveLength(1);
    expect(kv.store.get(rateKeys[0])).toBe('2');
  });

  it('429 once the window is exhausted', async () => {
    const { env } = makeEnv();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      const { response } = await call(makeRequest(VALID_BODY), env);
      expect(response.status).toBe(200);
    }
    const { response } = await call(makeRequest(VALID_BODY), env);
    expect(response.status).toBe(429);
  });

  it('is charged even for an oversized or malformed body', async () => {
    const { env, kv } = makeEnv();
    const big = streamOf([new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20)]);
    const tooLarge = await call(makeRequest(big), env);
    expect(tooLarge.response.status).toBe(413);
    const malformed = await call(makeRequest('{not json'), env);
    expect(malformed.response.status).toBe(400);
    const rateKeys = [...kv.store.keys()].filter((k) => k.startsWith('ratelimit:'));
    expect(rateKeys).toHaveLength(1);
    expect(kv.store.get(rateKeys[0])).toBe('2');
  });
});

describe('POST /share body cap (streamed, independent of Content-Length)', () => {
  it('413 when the streamed body exceeds the cap even with no Content-Length header', async () => {
    const { env, kv } = makeEnv();
    const chunks = [new Uint8Array(600).fill(0x20), new Uint8Array(600).fill(0x20)];
    const { response } = await call(makeRequest(streamOf(chunks)), env);
    expect(response.status).toBe(413);
    expect([...kv.store.keys()].some((k) => k.startsWith('share:'))).toBe(false);
  });

  it('accepts a valid body delivered as a stream under the cap', async () => {
    const { env } = makeEnv();
    const { response, json } = await call(makeRequest(streamOf([new TextEncoder().encode(VALID_BODY)])), env);
    expect(response.status).toBe(200);
    expect(json.id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('POST /share validation and success', () => {
  it('400 on a malformed payload, 422 on one over the theoretical ceiling', async () => {
    const { env } = makeEnv();
    const malformed = await call(makeRequest(JSON.stringify({ score: -1, stage: 1, hi: 0 })), env);
    expect(malformed.response.status).toBe(400);
    const tooHigh = await call(makeRequest(JSON.stringify({ score: Number.MAX_SAFE_INTEGER, stage: 1, hi: Number.MAX_SAFE_INTEGER })), env);
    expect(tooHigh.response.status).toBe(422);
  });

  it('stores the record under share:<id> and returns the id', async () => {
    const { env, kv } = makeEnv();
    const { response, json } = await call(makeRequest(VALID_BODY), env);
    expect(response.status).toBe(200);
    const id = json.id as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const stored = JSON.parse(kv.store.get(`share:${id}`)!);
    expect(stored).toMatchObject({ score: 100, stage: 2, hi: 100 });
    expect(typeof stored.at).toBe('number');
  });
});
