// POST /api/scores, exercised through the REAL handler
// (functions/api/scores.ts) with only D1/KV stubbed — docs/plans/2026-08-19-
// ranking-free-async task 9. Free-tier async-audit version: this handler
// never calls verifyReplay() (see functions/api/scores.ts's own module
// comment); score/stage are the client's claim, duration_ticks is derived
// server-side from an RLE decode-only pass, and an accepted submission is
// stored as `status='pending'`, never resolved to verified/rejected
// synchronously.
//
// Lives here (beside the other ranking unit tests) rather than in
// functions/api/, which is a Pages Functions route directory.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onRequestPost, readBodyWithLimit, isUniqueConstraintViolation } from '../../api/scores';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';
import { encodeRle, type InputSample } from '../../../src/core/rle';

const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'test-hmac-key-do-not-use-in-prod';

/** A short but well-formed RLE stream (decodes cleanly; not a real gameplay recording — POST never resimulates it). */
const SAMPLE_RLE: InputSample[] = [
  { dx: 0, dy: 1, drawHeld: true, slow: false },
  { dx: 1, dy: 0, drawHeld: false, slow: false },
];
const SAMPLE_RLE_BASE64 = (() => {
  const bytes = encodeRle(SAMPLE_RLE);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
})();

function validShapedBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    seed: 1264,
    rleBase64: SAMPLE_RLE_BASE64,
    score: 100,
    stage: 2,
    name: 'TESTER',
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    ...overrides,
  });
}

function makeRequest(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.1', ...headers },
    body,
    // Required by undici whenever the body is a stream.
    ...(typeof body === 'string' ? {} : { duplex: 'half' }),
  } as RequestInit);
}

/**
 * Env with an always-allowing rate limiter, a configured ip_hash key, and a
 * D1 whose `prepare(sql).bind(...).run()`/`.first()` behave as configured.
 * `thresholdScore` backs the pre-gate's "verified 10th place" SELECT — -1
 * (the COALESCE default, i.e. "fewer than 10 verified rows") unless
 * overridden.
 */
function makeEnv(opts: {
  runImpl?: (sql: string, args: unknown[]) => Promise<{ meta: { changes: number } }> | { meta: { changes: number } };
  thresholdScore?: number;
  ipHashKey?: string;
}) {
  const { runImpl, thresholdScore = -1, ipHashKey = IP_HASH_KEY } = opts;
  return {
    SHARES: {
      get: async () => null,
      put: async () => undefined,
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => ({ threshold: thresholdScore }),
          run: async () => {
            if (!runImpl) return { meta: { changes: 1 } };
            return runImpl(sql, args);
          },
        }),
      }),
    },
    RANKING_IP_HASH_KEY: ipHashKey,
  };
}

/** Env with RANKING_IP_HASH_KEY genuinely absent (not merely undefined-valued) — the shape an un-configured Pages secret actually has. */
function makeEnvMissingIpHashKey() {
  return {
    SHARES: { get: async () => null, put: async () => undefined },
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ threshold: -1 }), run: async () => ({ meta: { changes: 1 } }) }) }) },
  };
}

async function callHandler(request: Request, env: ReturnType<typeof makeEnv> | ReturnType<typeof makeEnvMissingIpHashKey>) {
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
    const env = makeEnv({
      runImpl: () => {
        throw new Error('run() must never be reached for an oversized body');
      },
    });
    const { response, body } = await callHandler(makeRequest(stream), env);
    expect(response.status).toBe(413);
    expect(body.error).toBe('request body too large');
  });

  it('still short-circuits on an oversized Content-Length header', async () => {
    const env = makeEnv({
      runImpl: () => {
        throw new Error('run() must never be reached');
      },
    });
    const { response } = await callHandler(makeRequest(validShapedBody(), { 'Content-Length': String(10 * 1024 * 1024) }), env);
    expect(response.status).toBe(413);
  });
});

describe('POST /api/scores ip_hash key gate (fail-closed)', () => {
  it('fails closed with 500 before any D1 operation when RANKING_IP_HASH_KEY is not configured', async () => {
    const env = makeEnvMissingIpHashKey();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(500);
    expect(body.accepted).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it('also fails closed for an empty-string key', async () => {
    const env = makeEnv({ ipHashKey: '' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { response } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(500);
  });
});

describe('POST /api/scores structural guarantee: verifyReplay() is never invoked', () => {
  it('never calls verifyReplay() on the accept path', async () => {
    const verifyModule = await import('./verifyReplay');
    const spy = vi.spyOn(verifyModule, 'verifyReplay');
    const env = makeEnv({});
    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never calls verifyReplay() on the out-of-range (pre-gate rejected) path', async () => {
    const verifyModule = await import('./verifyReplay');
    const spy = vi.spyOn(verifyModule, 'verifyReplay');
    const env = makeEnv({ thresholdScore: 999_999 }); // nothing can beat this
    const { response, body } = await callHandler(makeRequest(validShapedBody({ score: 5 })), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never calls verifyReplay() on the 429 (pending cap reached) path', async () => {
    const verifyModule = await import('./verifyReplay');
    const spy = vi.spyOn(verifyModule, 'verifyReplay');
    const env = makeEnv({ runImpl: () => ({ meta: { changes: 0 } }) });
    const { response } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });
});

// A Japanese name is a first-class case, not an edge case (this game's
// players type them): nameValidation.ts allows Unicode letters of any script
// and only bans control/invisible characters. Pinned end-to-end through the
// real handler after a device report (2026-08-20) about the submission form,
// so "the name survived the form" and "the server stores it verbatim" are
// both covered rather than assumed.
describe('POST /api/scores name/x_handle character handling', () => {
  it('accepts a Japanese name and stores it verbatim (no transliteration, no stripping)', async () => {
    const boundArgs: unknown[][] = [];
    const env = makeEnv({
      runImpl: (_sql, args) => {
        boundArgs.push(args);
        return { meta: { changes: 1 } };
      },
    });
    const { response, body } = await callHandler(makeRequest(validShapedBody({ name: 'しまぶ 太郎' })), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    // The INSERT really carried the name through unchanged.
    expect(boundArgs.some((args) => args.includes('しまぶ 太郎'))).toBe(true);
  });

  it('trims surrounding whitespace but leaves the Japanese text itself alone', async () => {
    const boundArgs: unknown[][] = [];
    const env = makeEnv({
      runImpl: (_sql, args) => {
        boundArgs.push(args);
        return { meta: { changes: 1 } };
      },
    });
    const { response } = await callHandler(makeRequest(validShapedBody({ name: '  しまぶ  ' })), env);
    expect(response.status).toBe(200);
    expect(boundArgs.some((args) => args.includes('しまぶ'))).toBe(true);
  });

  it('rejects a Japanese string used as an X HANDLE, with the reason naming the allowed pattern', async () => {
    // The UI now seeds the handle field from the name, so a Japanese name can
    // reach this field; nothing silently converts it, and this is the
    // rejection the player is shown (src/ui/ranking.ts surfaces `error` as
    // "NOT ACCEPTED (...)").
    const env = makeEnv({});
    const { response, body } = await callHandler(makeRequest(validShapedBody({ name: '', xHandle: 'しまぶ' })), env);
    expect(response.status).toBe(400);
    expect(String(body.error)).toContain('x_handle must match');
  });

  it('rejects a name carrying invisible/control characters (the case that IS filtered)', async () => {
    const env = makeEnv({});
    // U+200B (zero-width space) written as an escape, per nameValidation.ts's
    // own convention — a literal invisible character in source is unreviewable.
    const { response, body } = await callHandler(makeRequest(validShapedBody({ name: 'しまぶ\u200B' })), env);
    expect(response.status).toBe(400);
    expect(String(body.error)).toContain('control or invisible');
  });
});

describe('POST /api/scores score/stage validation', () => {
  it('rejects a negative score', async () => {
    const env = makeEnv({});
    const { response } = await callHandler(makeRequest(validShapedBody({ score: -1 })), env);
    expect(response.status).toBe(400);
  });

  it('rejects a non-integer score', async () => {
    const env = makeEnv({});
    const { response } = await callHandler(makeRequest(validShapedBody({ score: 1.5 })), env);
    expect(response.status).toBe(400);
  });

  it('rejects stage 0 (stage must be >= 1)', async () => {
    const env = makeEnv({});
    const { response } = await callHandler(makeRequest(validShapedBody({ stage: 0 })), env);
    expect(response.status).toBe(400);
  });

  it('accepts score 0 (0 is a valid, if unranked-in-practice, score)', async () => {
    const env = makeEnv({});
    const { response, body } = await callHandler(makeRequest(validShapedBody({ score: 0 })), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
  });
});

describe('POST /api/scores duration_ticks server derivation', () => {
  it('derives duration_ticks from the RLE sample count, not any client-supplied value', async () => {
    const env = makeEnv({});
    // The client never even has a duration field to lie with — ScoreSubmission
    // has none — but assert the *value* is what the RLE actually decodes to.
    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(200);
    expect(body.durationTicks).toBe(SAMPLE_RLE.length);
  });

  it('rejects malformed RLE data with 400, before ever reaching D1', async () => {
    let dbTouched = false;
    const env = makeEnv({ runImpl: () => ((dbTouched = true), { meta: { changes: 1 } }) });
    // 200 is not a valid sample code (src/core/rle.ts's decodeSampleByte()).
    const malformedBase64 = btoa(String.fromCharCode(200, 1));
    const { response, body } = await callHandler(makeRequest(validShapedBody({ rleBase64: malformedBase64 })), env);
    expect(response.status).toBe(400);
    expect(body.accepted).toBe(false);
    expect(dbTouched).toBe(false);
  });
});

describe('POST /api/scores pre-pending gate (out-of-range submissions are never stored)', () => {
  it('accepts unconditionally when fewer than 10 verified rows exist (threshold -1)', async () => {
    const env = makeEnv({ thresholdScore: -1 });
    const { response, body } = await callHandler(makeRequest(validShapedBody({ score: 0 })), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
  });

  it('rejects (without storing) a score equal to the verified 10th place — a tie is out of range', async () => {
    let dbTouched = false;
    const env = makeEnv({ thresholdScore: 100, runImpl: () => ((dbTouched = true), { meta: { changes: 1 } }) });
    const { response, body } = await callHandler(makeRequest(validShapedBody({ score: 100 })), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(false);
    expect(dbTouched).toBe(false);
  });

  it('accepts a score that strictly exceeds the verified 10th place', async () => {
    const env = makeEnv({ thresholdScore: 99 });
    const { response, body } = await callHandler(makeRequest(validShapedBody({ score: 100 })), env);
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
  });
});

describe('POST /api/scores D1 failure classification', () => {
  it('classifies a UNIQUE constraint violation as 409 duplicate replay, with no detail leaked', async () => {
    const env = makeEnv({
      runImpl: () => {
        throw new Error('D1_ERROR: UNIQUE constraint failed: scores.replay_hash');
      },
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
    const env = makeEnv({
      runImpl: () => {
        throw dbError;
      },
    });
    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(500);
    expect(body.error).toBe('internal error');
    expect(body.detail).toBeUndefined();
    // Nothing about the schema reaches the client...
    expect(JSON.stringify(body)).not.toMatch(/no such table|scores|offset/i);
    // ...but the operator can still see it.
    expect(consoleError).toHaveBeenCalledWith('POST /api/scores: D1 insert failed', dbError);
  });

  it('returns 429 (not deleting existing pending rows) when the atomic insert reports zero changes', async () => {
    const env = makeEnv({ runImpl: () => ({ meta: { changes: 0 } }) });
    const { response, body } = await callHandler(makeRequest(validShapedBody()), env);
    expect(response.status).toBe(429);
    expect(body.accepted).toBe(false);
  });
});

describe('POST /api/scores success response', () => {
  it('returns accepted:true, status:pending, and echoes score/stage/durationTicks', async () => {
    const env = makeEnv({});
    const { response, body } = await callHandler(makeRequest(validShapedBody({ score: 250, stage: 3 })), env);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ accepted: true, status: 'pending', score: 250, stage: 3 });
    expect(typeof body.id).toBe('string');
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
