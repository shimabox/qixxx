// GET /api/ranking/:id/replay, exercised through the REAL handler
// (functions/api/ranking/[id]/replay.ts) rather than a mocked response, per
// docs/plans/2026-08-16-score-ranking task 3's "この検証のテストを追加する
// こと". Only D1 itself is stubbed — the version comparison, the status
// codes, and the payload encoding are all the shipped code's own.
//
// The bulk of this file is the acceptance matrix for spec item 7's FIXED
// judgement order (docs/plans/2026-08-19-ranking-free-async, 2026-08-20
// revision):
//   1. no row / deleted by the audit        -> 404
//   2. pending AND expired (created_at <= now-24h) -> 404
//   3. season/ruleset/format mismatch       -> 410 (pending or verified)
//   4. otherwise                            -> 200 + status
// The order matters as much as the outcomes: an expired pending row at a
// stale version must resolve as 404 (rule 2) and never reach rule 3.
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
  status: 'verified' | 'pending';
  created_at: number;
}

const INPUT_BYTES = new Uint8Array([0x04, 0x0a, 0x11, 0x02]);
const HOUR_MS = 60 * 60 * 1000;
/** Comfortably inside the 24h freshness window (spec item 5's created_at > cutoff). */
const FRESH_AT = () => Date.now() - HOUR_MS;
/** Comfortably outside it (created_at <= cutoff). */
const EXPIRED_AT = () => Date.now() - 25 * HOUR_MS;

function currentRow(overrides: Partial<StubRow> = {}): StubRow {
  return {
    season_id: CURRENT_SEASON_ID,
    ruleset_version: RULESET_VERSION,
    replay_format_version: REPLAY_FORMAT_VERSION,
    seed: 1264,
    inputs: INPUT_BYTES.slice().buffer,
    status: 'verified',
    created_at: FRESH_AT(),
    ...overrides,
  };
}

/**
 * A D1 stub that answers `first()` with `row` and records every statement it
 * was asked to prepare.
 *
 * Note what it deliberately does NOT do anymore: filter by status. The
 * lookup is by id alone now (spec item 7's revision — pending rows are
 * servable), so every status/age/version decision is the handler's own and
 * is visible to these tests.
 */
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
    expect(body.status).toBe('verified');
    expect([...base64ToBytes(body.rleBase64 as string)]).toEqual([...INPUT_BYTES]);
    expect(bindings[0]).toEqual(['abc123']); // looked the row up by the requested public id
  });

  it('keeps the row: a 410 issues no DELETE/UPDATE, only the SELECT', async () => {
    // Task 3's confirmed spec: "データ自体は保持し、削除しないこと".
    const { statements } = await callHandler(currentRow({ replay_format_version: REPLAY_FORMAT_VERSION + 99 }));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*SELECT/i);
    expect(statements.join(' ')).not.toMatch(/DELETE|UPDATE|INSERT/i);
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

  // docs/plans/2026-08-19-ranking-free-async spec item 7's acceptance matrix.
  describe('fixed judgement order', () => {
    describe('1. row missing (never existed, or deleted by the audit) -> 404', () => {
      it('returns 404 for an unknown id (distinct from the 410 "exists but not replayable" case)', async () => {
        const { response, body } = await callHandler(null);
        expect(response.status).toBe(404);
        expect(body.error).toBe('not found');
        expect(body.rleBase64).toBeUndefined();
      });
    });

    describe('2. pending AND expired -> 404 (evaluated BEFORE the version check)', () => {
      it('returns 404 for an expired pending row at the current season/ruleset/format', async () => {
        const { response, body } = await callHandler(currentRow({ status: 'pending', created_at: EXPIRED_AT() }));
        expect(response.status).toBe(404);
        expect(body.error).toBe('not found');
        expect(body.rleBase64).toBeUndefined();
      });

      it('returns 404 — NOT 410 — for an expired pending row that ALSO has a version mismatch (no overlap between rules 2 and 3)', async () => {
        const { response, body } = await callHandler(
          currentRow({ status: 'pending', created_at: EXPIRED_AT(), replay_format_version: REPLAY_FORMAT_VERSION + 1, season_id: CURRENT_SEASON_ID - 1 })
        );
        expect(response.status).toBe(404);
        expect(body.error).toBe('not found');
        expect(body.replayAvailable).toBeUndefined(); // the 410 body's own field never appears
      });

      it('never applies rule 2 to a verified row: an ancient verified row is still served', async () => {
        const { response, body } = await callHandler(currentRow({ status: 'verified', created_at: Date.now() - 400 * 24 * HOUR_MS }));
        expect(response.status).toBe(200);
        expect(body.status).toBe('verified');
      });
    });

    describe('3. version mismatch -> 410, for pending and verified alike', () => {
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

      it('returns 410 for a FRESH pending row whose version has moved on (status makes no difference to rule 3)', async () => {
        for (const mismatch of [
          { season_id: CURRENT_SEASON_ID - 1 },
          { ruleset_version: RULESET_VERSION - 1 },
          { replay_format_version: REPLAY_FORMAT_VERSION + 1 },
        ]) {
          const { response, body } = await callHandler(currentRow({ status: 'pending', created_at: FRESH_AT(), ...mismatch }));
          expect(response.status).toBe(410);
          expect(body.rleBase64).toBeUndefined();
        }
      });
    });

    describe('4. otherwise -> 200 with `status`', () => {
      it('serves a FRESH pending row and reports status:"pending"', async () => {
        const { response, body } = await callHandler(currentRow({ status: 'pending', created_at: FRESH_AT() }));
        expect(response.status).toBe(200);
        expect(body.status).toBe('pending');
        expect([...base64ToBytes(body.rleBase64 as string)]).toEqual([...INPUT_BYTES]);
      });

      it('reports status:"verified" for a verified row, so the viewer shows no VERIFYING notice', async () => {
        const { body } = await callHandler(currentRow({ status: 'verified' }));
        expect(body.status).toBe('verified');
      });

      it('looks rows up by id ALONE — the old status="verified" SQL filter is gone, so pending rows are reachable', async () => {
        const { statements } = await callHandler(currentRow({ status: 'pending' }));
        expect(statements[0]).not.toMatch(/status\s*=\s*'verified'/i);
        expect(statements[0]).toMatch(/WHERE\s+id\s*=\s*\?/i);
      });
    });
  });
});
