// GET /api/ranking, exercised through the REAL handler
// (functions/api/ranking.ts) with an in-memory D1 stub — docs/plans/2026-08
// -19-ranking-free-async task 9. Covers the Free-tier async-audit
// extensions: the confirmed board is verified-only, and `pendingEntries`
// (unranked, provisionally-in-range pending rows) is returned alongside it
// without ever influencing the confirmed board's ranks/ordering.
import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../../api/ranking';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from './season';

interface FakeRow {
  rank_seq: number;
  id: string;
  season_id: number;
  ruleset_version: number;
  replay_format_version: number;
  score: number;
  stage: number;
  name: string;
  x_handle: string | null;
  created_at: number;
  status: 'verified' | 'pending';
}

/**
 * An in-memory D1 stand-in that actually interprets the two query shapes
 * functions/api/ranking.ts (via functions/_lib/ranking/pendingGate.ts)
 * issues — a verified-TOP10 `.all()`, a COALESCE-10th-place `.first()`, and a
 * pending-entries `.all()` — closely enough to exercise the real filtering/
 * ordering/threshold logic rather than merely returning canned data.
 */
function makeFakeDb(rows: FakeRow[]) {
  function sorted(list: FakeRow[]): FakeRow[] {
    return [...list].sort((a, b) => b.score - a.score || a.rank_seq - b.rank_seq);
  }
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            all: async () => {
              if (/status = 'verified'/.test(sql)) {
                const [seasonId, rulesetVersion] = args as [number, number];
                const filtered = rows.filter((r) => r.status === 'verified' && r.season_id === seasonId && r.ruleset_version === rulesetVersion);
                return { results: sorted(filtered).slice(0, 10) };
              }
              if (/status = 'pending'/.test(sql)) {
                const [seasonId, rulesetVersion, threshold, expiryCutoff, limit] = args as [number, number, number, number, number];
                const filtered = rows.filter(
                  (r) =>
                    r.status === 'pending' &&
                    r.season_id === seasonId &&
                    r.ruleset_version === rulesetVersion &&
                    r.score > threshold &&
                    r.created_at > expiryCutoff
                );
                return { results: sorted(filtered).slice(0, limit) };
              }
              throw new Error(`unexpected .all() query: ${sql}`);
            },
            first: async () => {
              if (/COALESCE/.test(sql)) {
                const [seasonId, rulesetVersion] = args as [number, number];
                const verified = sorted(rows.filter((r) => r.status === 'verified' && r.season_id === seasonId && r.ruleset_version === rulesetVersion));
                const tenth = verified[9];
                return { threshold: tenth ? tenth.score : -1 };
              }
              throw new Error(`unexpected .first() query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

async function callHandler(rows: FakeRow[]) {
  const env = { DB: makeFakeDb(rows) };
  type Ctx = Parameters<typeof onRequestGet>[0];
  const response = await onRequestGet({ env, params: {} } as unknown as Ctx);
  const body = (await response.json()) as {
    seasonId: number;
    rulesetVersion: number;
    entries: { id: string; score: number; replayAvailable: boolean }[];
    pendingEntries: { id: string; score: number; unverified: true }[];
  };
  return { response, body };
}

function row(overrides: Partial<FakeRow> & Pick<FakeRow, 'rank_seq' | 'id' | 'score'>): FakeRow {
  return {
    season_id: CURRENT_SEASON_ID,
    ruleset_version: RULESET_VERSION,
    replay_format_version: REPLAY_FORMAT_VERSION,
    stage: 1,
    name: 'PLAYER',
    x_handle: null,
    created_at: Date.now(),
    status: 'verified',
    ...overrides,
  };
}

describe('GET /api/ranking', () => {
  it('returns an empty board and empty pendingEntries with no rows at all', async () => {
    const { response, body } = await callHandler([]);
    expect(response.status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.pendingEntries).toEqual([]);
    expect(body.seasonId).toBe(CURRENT_SEASON_ID);
    expect(body.rulesetVersion).toBe(RULESET_VERSION);
  });

  it('returns only verified rows in the confirmed board, ordered score DESC then rank_seq ASC', async () => {
    const rows = [
      row({ rank_seq: 1, id: 'a', score: 100 }),
      row({ rank_seq: 2, id: 'b', score: 300 }),
      row({ rank_seq: 3, id: 'c', score: 300 }), // ties b on score; rank_seq breaks the tie
      row({ rank_seq: 4, id: 'd', score: 999, status: 'pending' }), // pending: must NOT appear in entries
    ];
    const { body } = await callHandler(rows);
    expect(body.entries.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('flags replayAvailable false for a verified row at a stale replay_format_version', async () => {
    const rows = [row({ rank_seq: 1, id: 'a', score: 100, replay_format_version: REPLAY_FORMAT_VERSION + 1 })];
    const { body } = await callHandler(rows);
    expect(body.entries[0].replayAvailable).toBe(false);
  });

  // docs/plans/2026-08-19-ranking-free-async spec item 5.
  describe('pendingEntries', () => {
    it('verified < 10: unconditionally includes pending rows regardless of score (COALESCE(...,-1) boundary)', async () => {
      const rows = [row({ rank_seq: 1, id: 'p1', score: 0, status: 'pending' })];
      const { body } = await callHandler(rows);
      expect(body.pendingEntries.map((e) => e.id)).toEqual(['p1']);
      expect(body.pendingEntries[0].unverified).toBe(true);
    });

    it('verified >= 10: excludes a pending score tied with the verified 10th place', async () => {
      const verifiedTen = Array.from({ length: 10 }, (_, i) => row({ rank_seq: i + 1, id: `v${i}`, score: 100 - i }));
      const tiedPending = row({ rank_seq: 20, id: 'tied', score: 91, status: 'pending' }); // ties the 10th place (91)
      const { body } = await callHandler([...verifiedTen, tiedPending]);
      expect(body.pendingEntries).toEqual([]);
    });

    it('verified >= 10: includes a pending score that strictly exceeds the verified 10th place', async () => {
      const verifiedTen = Array.from({ length: 10 }, (_, i) => row({ rank_seq: i + 1, id: `v${i}`, score: 100 - i }));
      const beats = row({ rank_seq: 20, id: 'beats', score: 92, status: 'pending' }); // strictly beats 91
      const { body } = await callHandler([...verifiedTen, beats]);
      expect(body.pendingEntries.map((e) => e.id)).toEqual(['beats']);
    });

    it('caps pendingEntries at 3, ordered by declared score DESC', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => row({ rank_seq: i + 1, id: `p${i}`, score: i * 10, status: 'pending' }));
      const { body } = await callHandler(rows);
      expect(body.pendingEntries).toHaveLength(3);
      expect(body.pendingEntries.map((e) => e.score)).toEqual([40, 30, 20]);
    });

    it('excludes a pending row older than 24 hours (spec item 7\'s "監査停止時の保護")', async () => {
      const old = row({ rank_seq: 1, id: 'stale', score: 500, status: 'pending', created_at: Date.now() - 25 * 60 * 60 * 1000 });
      const fresh = row({ rank_seq: 2, id: 'fresh', score: 500, status: 'pending', created_at: Date.now() - 1000 });
      const { body } = await callHandler([old, fresh]);
      expect(body.pendingEntries.map((e) => e.id)).toEqual(['fresh']);
    });

    it('excludes a pending row from a different season/ruleset', async () => {
      const otherSeason = row({ rank_seq: 1, id: 'other', score: 500, status: 'pending', season_id: CURRENT_SEASON_ID + 1 });
      const { body } = await callHandler([otherSeason]);
      expect(body.pendingEntries).toEqual([]);
    });

    it('never influences the confirmed board: entries stay verified-only and in the same order regardless of pendingEntries content', async () => {
      const verifiedTwo = [row({ rank_seq: 1, id: 'v0', score: 50 }), row({ rank_seq: 2, id: 'v1', score: 40 })];
      const hugePending = row({ rank_seq: 3, id: 'huge', score: 999999, status: 'pending' });
      const { body } = await callHandler([...verifiedTwo, hugePending]);
      expect(body.entries.map((e) => e.id)).toEqual(['v0', 'v1']); // 'huge' never inserted despite outscoring both
      expect(body.pendingEntries.map((e) => e.id)).toEqual(['huge']);
    });
  });
});
