// GET /api/ranking, exercised through the REAL handler
// (functions/api/ranking.ts) with an in-memory D1 stub. Covers the two field families the Free-tier
// async-audit version returns: `entries` (verified-only, the submission
// -eligibility basis) and `displayEntries` (verified + fresh pending merged
// into one board under the same ordering), and the fact that the
// first is computed independently of the second.
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
 * functions/api/ranking.ts issues — a verified `.all()` and a fresh-pending
 * `.all()` — including their LIMITs and their `score DESC, rank_seq ASC`
 * ordering, so the merge/threshold logic under test is the shipped code's
 * own rather than canned data. Records each query's bound LIMIT so the
 * "candidates are narrowed IN SQL, not in JS" requirement can be asserted
 * directly.
 */
function makeFakeDb(rows: FakeRow[]) {
  const pendingLimits: number[] = [];
  function sorted(list: FakeRow[]): FakeRow[] {
    return [...list].sort((a, b) => b.score - a.score || a.rank_seq - b.rank_seq);
  }
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            all: async () => {
              if (/status = 'verified'/.test(sql)) {
                const [seasonId, rulesetVersion, limit] = args as [number, number, number];
                const filtered = rows.filter((r) => r.status === 'verified' && r.season_id === seasonId && r.ruleset_version === rulesetVersion);
                return { results: sorted(filtered).slice(0, limit) };
              }
              if (/status = 'pending'/.test(sql)) {
                const [seasonId, rulesetVersion, cutoff, limit] = args as [number, number, number, number];
                pendingLimits.push(limit);
                const filtered = rows.filter(
                  (r) =>
                    r.status === 'pending' &&
                    r.season_id === seasonId &&
                    r.ruleset_version === rulesetVersion &&
                    // The shared freshness boundary is created_at > cutoff.
                    r.created_at > cutoff
                );
                return { results: sorted(filtered).slice(0, limit) };
              }
              throw new Error(`unexpected .all() query: ${sql}`);
            },
            first: async () => {
              throw new Error(`unexpected .first() query: ${sql}`);
            },
          };
        },
      };
    },
  };
  return { db, pendingLimits };
}

interface DisplayEntryShape {
  id: string;
  score: number;
  status: 'pending' | 'verified';
  replayAvailable: boolean;
  name: string;
  xHandle: string | null;
  stage: number;
  createdAt: string;
}

async function callHandler(rows: FakeRow[]) {
  const { db, pendingLimits } = makeFakeDb(rows);
  const env = { DB: db };
  type Ctx = Parameters<typeof onRequestGet>[0];
  const response = await onRequestGet({ env, params: {} } as unknown as Ctx);
  const body = (await response.json()) as {
    seasonId: number;
    rulesetVersion: number;
    entries: { id: string; score: number; replayAvailable: boolean }[];
    displayEntries: DisplayEntryShape[];
  };
  return { response, body, pendingLimits };
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
  it('returns an empty board and empty displayEntries with no rows at all', async () => {
    const { response, body } = await callHandler([]);
    expect(response.status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.displayEntries).toEqual([]);
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

  // Verified and fresh pending rows share one merged display board.
  describe('displayEntries (the merged board)', () => {
    it('merges verified and pending into ONE list under score DESC, rank_seq ASC, tagging each row with its status', async () => {
      const rows = [
        row({ rank_seq: 1, id: 'v1', score: 900 }),
        row({ rank_seq: 2, id: 'v2', score: 700 }),
        row({ rank_seq: 3, id: 'p1', score: 800, status: 'pending' }),
      ];
      const { body } = await callHandler(rows);
      expect(body.displayEntries.map((e) => [e.id, e.status])).toEqual([
        ['v1', 'verified'],
        ['p1', 'pending'],
        ['v2', 'verified'],
      ]);
    });

    it('breaks a verified/pending score tie by rank_seq (first-come-first-served), same as any other tie', async () => {
      const rows = [
        row({ rank_seq: 5, id: 'later-verified', score: 500 }),
        row({ rank_seq: 2, id: 'earlier-pending', score: 500, status: 'pending' }),
      ];
      const { body } = await callHandler(rows);
      expect(body.displayEntries.map((e) => e.id)).toEqual(['earlier-pending', 'later-verified']);
    });

    it('keeps the full RankingEntry shape on a pending row, replayAvailable included', async () => {
      const rows = [row({ rank_seq: 1, id: 'p1', score: 10, stage: 4, name: 'PN', x_handle: 'ph', status: 'pending' })];
      const { body } = await callHandler(rows);
      expect(body.displayEntries[0]).toEqual({
        id: 'p1',
        createdAt: expect.any(String),
        score: 10,
        stage: 4,
        name: 'PN',
        xHandle: 'ph',
        replayAvailable: true,
        status: 'pending',
      });
    });

    it('flags replayAvailable false for a pending row at a stale replay_format_version', async () => {
      const rows = [row({ rank_seq: 1, id: 'p1', score: 10, status: 'pending', replay_format_version: REPLAY_FORMAT_VERSION + 1 })];
      const { body } = await callHandler(rows);
      expect(body.displayEntries[0].replayAvailable).toBe(false);
    });

    it('shows at most 10 rows: the 11th-best row of the merged set is not displayed', async () => {
      const verified = Array.from({ length: 10 }, (_, i) => row({ rank_seq: i + 1, id: `v${i}`, score: 1000 - i }));
      const pending = row({ rank_seq: 50, id: 'p-top', score: 5000, status: 'pending' });
      const { body } = await callHandler([...verified, pending]);
      expect(body.displayEntries).toHaveLength(10);
      expect(body.displayEntries[0].id).toBe('p-top');
      // v9 (the weakest verified row) is pushed off the board by the pending row.
      expect(body.displayEntries.map((e) => e.id)).not.toContain('v9');
    });

    it('narrows pending CANDIDATES to 3 in SQL (LIMIT 3), so 4+ pending rows never contribute more than 3 rows', async () => {
      const pending = Array.from({ length: 6 }, (_, i) => row({ rank_seq: i + 1, id: `p${i}`, score: 100 - i, status: 'pending' }));
      const { body, pendingLimits } = await callHandler(pending);
      expect(pendingLimits).toEqual([3]); // the cap is applied by the query itself, not by post-filtering in JS
      expect(body.displayEntries.filter((e) => e.status === 'pending')).toHaveLength(3);
      expect(body.displayEntries.map((e) => e.id)).toEqual(['p0', 'p1', 'p2']);
    });

    it('with 4+ EQUAL-SCORE pending rows, score DESC + rank_seq ASC picks the three earliest (first-come)', async () => {
      const tied = [
        row({ rank_seq: 40, id: 'fourth', score: 777, status: 'pending' }),
        row({ rank_seq: 10, id: 'first', score: 777, status: 'pending' }),
        row({ rank_seq: 30, id: 'third', score: 777, status: 'pending' }),
        row({ rank_seq: 20, id: 'second', score: 777, status: 'pending' }),
      ];
      const { body } = await callHandler(tied);
      expect(body.displayEntries.map((e) => e.id)).toEqual(['first', 'second', 'third']);
    });

    it('leaves at least 7 verified rows on a 10-row board even when 3 pending rows outscore everything', async () => {
      const verified = Array.from({ length: 10 }, (_, i) => row({ rank_seq: i + 1, id: `v${i}`, score: 100 - i }));
      const pending = Array.from({ length: 5 }, (_, i) => row({ rank_seq: 100 + i, id: `p${i}`, score: 9000 + i, status: 'pending' }));
      const { body } = await callHandler([...verified, ...pending]);
      expect(body.displayEntries.filter((e) => e.status === 'pending')).toHaveLength(3);
      expect(body.displayEntries.filter((e) => e.status === 'verified')).toHaveLength(7);
    });

    it('excludes an EXPIRED pending row (created_at <= now-24h) from the board entirely', async () => {
      const stale = row({ rank_seq: 1, id: 'stale', score: 500, status: 'pending', created_at: Date.now() - 25 * 60 * 60 * 1000 });
      const fresh = row({ rank_seq: 2, id: 'fresh', score: 500, status: 'pending', created_at: Date.now() - 1000 });
      const { body } = await callHandler([stale, fresh]);
      expect(body.displayEntries.map((e) => e.id)).toEqual(['fresh']);
    });

    it('excludes a pending row from a different season/ruleset', async () => {
      const otherSeason = row({ rank_seq: 1, id: 'other', score: 500, status: 'pending', season_id: CURRENT_SEASON_ID + 1 });
      const otherRuleset = row({ rank_seq: 2, id: 'other-rules', score: 500, status: 'pending', ruleset_version: RULESET_VERSION + 1 });
      const { body } = await callHandler([otherSeason, otherRuleset]);
      expect(body.displayEntries).toEqual([]);
    });

    it('shows pending rows unconditionally when fewer than 10 verified rows exist (no threshold filtering on the display side)', async () => {
      // Deliberately a pending score BELOW every verified row: the display
      // side has no eligibility threshold of its own — that is the submission
      // gate's job; the merged display never changes submission eligibility.
      const rows = [row({ rank_seq: 1, id: 'v0', score: 900 }), row({ rank_seq: 2, id: 'p-low', score: 1, status: 'pending' })];
      const { body } = await callHandler(rows);
      expect(body.displayEntries.map((e) => [e.id, e.status])).toEqual([
        ['v0', 'verified'],
        ['p-low', 'pending'],
      ]);
    });
  });

  // Pending rows must not change the verified-only submission basis.
  describe('entries stays independent of displayEntries', () => {
    it('is unchanged by pending rows that dominate the merged board', async () => {
      const verifiedTwo = [row({ rank_seq: 1, id: 'v0', score: 50 }), row({ rank_seq: 2, id: 'v1', score: 40 })];
      const withoutPending = await callHandler(verifiedTwo);
      const hugePending = Array.from({ length: 3 }, (_, i) => row({ rank_seq: 10 + i, id: `huge${i}`, score: 999999, status: 'pending' }));
      const withPending = await callHandler([...verifiedTwo, ...hugePending]);

      expect(withPending.body.entries).toEqual(withoutPending.body.entries);
      expect(withPending.body.entries.map((e) => e.id)).toEqual(['v0', 'v1']);
      // ...while the DISPLAY board did change, proving the two are computed apart.
      expect(withPending.body.displayEntries.map((e) => e.id)).toEqual(['huge0', 'huge1', 'huge2', 'v0', 'v1']);
    });

    it('keeps the verified 10th place (the submission threshold) untouched when 3 pending rows outrank it', async () => {
      const verified = Array.from({ length: 10 }, (_, i) => row({ rank_seq: i + 1, id: `v${i}`, score: 100 - i }));
      const pending = Array.from({ length: 3 }, (_, i) => row({ rank_seq: 100 + i, id: `p${i}`, score: 9000, status: 'pending' }));
      const { body } = await callHandler([...verified, ...pending]);
      expect(body.entries).toHaveLength(10);
      expect(body.entries[9].score).toBe(91); // v9 — still the 10th place a submitter must beat
    });
  });
});
