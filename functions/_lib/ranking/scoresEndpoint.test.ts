// POST /api/scores, exercised through the REAL handler
// (functions/api/scores.ts) with only D1/KV stubbed. Covers the two
// failure-classification paths a user review flagged: an oversized body must
// be rejected while it is still streaming (never buffered whole), and a D1
// error must only be reported as 409 "duplicate replay" when it genuinely is
// one — anything else is a 500 that leaks no database internals.
//
// Lives here (beside the other ranking unit tests) rather than in
// functions/api/, which is a Pages Functions route directory.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onRequestPost, readBodyWithLimit, isUniqueConstraintViolation } from '../../api/scores';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';

const SELF_ORIGIN = 'https://qixxx.example';

/** A body that reaches verifyReplay() but is rejected there — enough to drive the handler past every input check. */
function validShapedBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    seed: 1264,
    rleBase64: 'AAE=',
    name: 'TESTER',
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    ...overrides,
  });
}

function makeRequest(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', ...headers },
    body,
    // Required by undici whenever the body is a stream.
    ...(typeof body === 'string' ? {} : { duplex: 'half' }),
  } as RequestInit);
}

/** Env with an always-allowing rate limiter and a D1 whose batch() behaves as configured. */
function makeEnv(batchImpl: () => Promise<unknown>) {
  return {
    SHARES: {
      get: async () => null,
      put: async () => undefined,
    },
    DB: {
      prepare: () => ({ bind: () => ({}) }),
      batch: batchImpl,
    },
  };
}

async function callHandler(request: Request, env: ReturnType<typeof makeEnv>) {
  type Ctx = Parameters<typeof onRequestPost>[0];
  const response = await onRequestPost({ request, env, params: {} } as unknown as Ctx);
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readBodyWithLimit', () => {
  it('reads a body under the cap intact, including multi-byte characters split across chunks', async () => {
    const encoded = new TextEncoder().encode('{"name":"にほんご"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-character on purpose: a naive per-chunk decode would
        // corrupt this into replacement characters.
        controller.enqueue(encoded.slice(0, 12));
        controller.enqueue(encoded.slice(12));
        controller.close();
      },
    });
    const result = await readBodyWithLimit(stream, 1024);
    expect(result).toEqual({ ok: true, text: '{"name":"にほんご"}' });
  });

  it('stops and reports too-large without buffering the whole stream, and cancels it', async () => {
    const cap = 1024;
    let enqueued = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // A body that would be effectively unbounded if fully drained.
        if (enqueued > 5_000_000) return controller.close();
        enqueued += 4096;
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await readBodyWithLimit(stream, cap);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(cancelled).toBe(true);
    // Bailed almost immediately rather than reading megabytes first.
    expect(enqueued).toBeLessThan(cap + 4096 * 4);
  });

  it('reports read-failed (not too-large) when the stream errors', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('boom'));
      },
    });
    expect(await readBodyWithLimit(stream, 1024)).toEqual({ ok: false, reason: 'read-failed' });
  });

  it('treats a null body as empty', async () => {
    expect(await readBodyWithLimit(null, 1024)).toEqual({ ok: true, text: '' });
  });
});

describe('POST /api/scores body size enforcement', () => {
  it('rejects an oversized body with 413 even when Content-Length is absent or understated', async () => {
    // No Content-Length the handler can trust: the body is a stream, and the
    // 300 KiB it produces is past MAX_BODY_BYTES (256 KiB). The streaming
    // read is the only thing standing between this and a buffered 300 KiB.
    const payload = new Uint8Array(300 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const env = makeEnv(async () => {
      throw new Error('batch() must never be reached for an oversized body');
    });
    const { response, body } = await callHandler(makeRequest(stream), env);
    expect(response.status).toBe(413);
    expect(body.error).toBe('request body too large');
  });

  it('still short-circuits on an oversized Content-Length header', async () => {
    const env = makeEnv(async () => {
      throw new Error('batch() must never be reached');
    });
    const { response } = await callHandler(makeRequest(validShapedBody(), { 'Content-Length': String(10 * 1024 * 1024) }), env);
    expect(response.status).toBe(413);
  });
});

describe('POST /api/scores D1 failure classification', () => {
  // A replay that fails verification stops before D1, so these tests need a
  // submission that actually reaches the batch. verifyReplay() is real here,
  // so we assert on what it produces rather than faking it: an unverifiable
  // replay yields 422 and never touches D1.
  it('never reaches D1 when the replay fails verification', async () => {
    let batched = false;
    const env = makeEnv(async () => {
      batched = true;
      return [];
    });
    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(422);
    expect(body.accepted).toBe(false);
    expect(batched).toBe(false);
  });

  it('classifies a UNIQUE constraint violation as 409 duplicate replay, with no detail leaked', async () => {
    const env = makeEnv(async () => {
      throw new Error('D1_ERROR: UNIQUE constraint failed: scores.replay_hash');
    });
    // Reach the batch by making verifyReplay() accept: stub it at the module
    // boundary the handler imports.
    const verify = await import('../../_lib/ranking/verifyReplay');
    vi.spyOn(verify, 'verifyReplay').mockReturnValue({
      ok: true,
      score: 100,
      stage: 1,
      durationTicks: 500,
      totalClaims: 1,
      gameOverReason: 'life',
    });

    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(409);
    expect(body.error).toBe('duplicate replay');
    expect(body.accepted).toBe(false);
    expect(body.detail).toBeUndefined(); // no raw D1 message echoed back
  });

  it('classifies any other D1 failure as a generic 500 that leaks nothing, and logs it server-side', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbError = new Error('D1_ERROR: no such table: scores at offset 13');
    const env = makeEnv(async () => {
      throw dbError;
    });
    const verify = await import('../../_lib/ranking/verifyReplay');
    vi.spyOn(verify, 'verifyReplay').mockReturnValue({
      ok: true,
      score: 100,
      stage: 1,
      durationTicks: 500,
      totalClaims: 1,
      gameOverReason: 'life',
    });

    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(500);
    expect(body.error).toBe('internal error');
    expect(body.detail).toBeUndefined();
    // Nothing about the schema reaches the client...
    expect(JSON.stringify(body)).not.toMatch(/no such table|scores|offset/i);
    // ...but the operator can still see it.
    expect(consoleError).toHaveBeenCalledWith('POST /api/scores: D1 batch failed', dbError);
  });
});

describe('isUniqueConstraintViolation', () => {
  it('matches D1/SQLite UNIQUE failures', () => {
    expect(isUniqueConstraintViolation(new Error('UNIQUE constraint failed: scores.replay_hash'))).toBe(true);
    expect(isUniqueConstraintViolation(new Error('D1_ERROR: unique constraint FAILED: scores.id'))).toBe(true);
  });

  it('does not match unrelated failures (which must surface as 500, not a false duplicate)', () => {
    for (const err of [
      new Error('no such table: scores'),
      new Error('D1_ERROR: network error'),
      new Error('CHECK constraint failed'),
      'not an error object',
      undefined,
    ]) {
      expect(isUniqueConstraintViolation(err)).toBe(false);
    }
  });
});
