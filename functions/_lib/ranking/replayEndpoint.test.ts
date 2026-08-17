// GET /api/ranking/:id/replay, exercised through the REAL handler
// (functions/api/ranking/[id]/replay.ts) rather than a mocked response, per
// docs/plans/2026-08-16-score-ranking task 3's "この検証のテストを追加する
// こと". Only D1 itself is stubbed — the version comparison, the status
// codes, and the payload encoding are all the shipped code's own.
//
// Lives here (next to the other ranking unit tests) rather than beside the
// handler: `functions/api/ranking/[id]/` is a Pages Functions *route*
// directory, where a stray .test.ts would be one more file the router has to
// ignore.
import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../../api/ranking/[id]/replay';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';

interface StubRow {
  season_id: number;
  ruleset_version: number;
  replay_format_version: number;
  seed: number;
  inputs: ArrayBuffer;
}

const INPUT_BYTES = new Uint8Array([0x04, 0x0a, 0x11, 0x02]);

function currentRow(overrides: Partial<StubRow> = {}): StubRow {
  return {
    season_id: CURRENT_SEASON_ID,
    ruleset_version: RULESET_VERSION,
    replay_format_version: REPLAY_FORMAT_VERSION,
    seed: 1264,
    inputs: INPUT_BYTES.slice().buffer,
    ...overrides,
  };
}

/** A D1 stub that answers `first()` with `row` and records every statement it was asked to prepare. */
function makeEnv(row: StubRow | null) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind(...args: unknown[]) {
            bindings.push(args);
            return { first: async () => row };
          },
        };
      },
    },
  };
  return { env, statements, bindings };
}

async function callHandler(row: StubRow | null, params: Record<string, unknown> = { id: 'abc123' }) {
  const { env, statements, bindings } = makeEnv(row);
  type Ctx = Parameters<typeof onRequestGet>[0];
  const response = await onRequestGet({ env, params } as unknown as Ctx);
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body, statements, bindings };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe('GET /api/ranking/:id/replay', () => {
  it('serves the replay payload when season, ruleset and format all match the current values', async () => {
    const { response, body, bindings } = await callHandler(currentRow());
    expect(response.status).toBe(200);
    expect(body.seed).toBe(1264);
    expect(body.rulesetVersion).toBe(RULESET_VERSION);
    expect(body.replayFormatVersion).toBe(REPLAY_FORMAT_VERSION);
    expect([...base64ToBytes(body.rleBase64 as string)]).toEqual([...INPUT_BYTES]);
    expect(bindings[0]).toEqual(['abc123']); // looked the row up by the requested public id
  });

  it('returns 410 for a stale replay_format_version', async () => {
    const { response, body } = await callHandler(currentRow({ replay_format_version: REPLAY_FORMAT_VERSION + 1 }));
    expect(response.status).toBe(410);
    expect(body.replayAvailable).toBe(false);
    expect(body.rleBase64).toBeUndefined(); // no replay data leaks out on the refusal path
  });

  it('returns 410 for a previous season, even at the current ruleset/format', async () => {
    const { response, body } = await callHandler(currentRow({ season_id: CURRENT_SEASON_ID - 1 }));
    expect(response.status).toBe(410);
    expect(body.replayAvailable).toBe(false);
  });

  it('returns 410 for a previous ruleset_version', async () => {
    const { response, body } = await callHandler(currentRow({ ruleset_version: RULESET_VERSION - 1 }));
    expect(response.status).toBe(410);
    expect(body.replayAvailable).toBe(false);
  });

  it('keeps the row: a 410 issues no DELETE/UPDATE, only the SELECT', async () => {
    // Task 3's confirmed spec: "データ自体は保持し、削除しないこと".
    const { statements } = await callHandler(currentRow({ replay_format_version: REPLAY_FORMAT_VERSION + 99 }));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*SELECT/i);
    expect(statements.join(' ')).not.toMatch(/DELETE|UPDATE|INSERT/i);
  });

  it('returns 404 for an unknown id (distinct from the 410 "exists but not replayable" case)', async () => {
    const { response, body } = await callHandler(null);
    expect(response.status).toBe(404);
    expect(body.error).toBe('not found');
  });

  it('returns 400 when the route parameter is missing', async () => {
    const { response } = await callHandler(currentRow(), {});
    expect(response.status).toBe(400);
  });

  it('accepts an array-shaped route parameter (Pages catch-all form) by using its first segment', async () => {
    const { response, bindings } = await callHandler(currentRow(), { id: ['abc123', 'ignored'] });
    expect(response.status).toBe(200);
    expect(bindings[0]).toEqual(['abc123']);
  });
});
