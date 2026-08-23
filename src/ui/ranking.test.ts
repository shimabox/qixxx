// Pure (DOM-free) half of the ranking submission flow: eligibility, the
// provisional-in-range boundary, and the async races between "ask the server
// for the current top 10" and "the player has already moved on".
//
// Only the pure exports of src/ui/ranking.ts are imported here — initRankingUI()
// itself is DOM-bound and is covered by tests/e2e/ranking.spec.ts instead
// (vitest runs in the `node` environment for this repo; see vitest.config.ts).
import { describe, it, expect } from 'vitest';
import {
  decideSubmissionOffer,
  isSnapshotEligible,
  isReplayPayloadPlayable,
  formatRankingDate,
  stopKeyPropagation,
  type RankingEntry,
  type RunSubmissionSnapshot,
} from './ranking';

describe('stopKeyPropagation', () => {
  for (const type of ['keydown', 'keyup']) {
    it(`keeps ${type} from reaching document and window listeners`, () => {
      const control = new EventTarget();
      const documentTarget = new EventTarget();
      const windowTarget = new EventTarget();
      let documentEvents = 0;
      let windowEvents = 0;
      documentTarget.addEventListener(type, () => documentEvents++);
      windowTarget.addEventListener(type, () => windowEvents++);
      stopKeyPropagation(control as HTMLElement);

      const event = new Event(type, { bubbles: true });
      control.dispatchEvent(event);
      if (!event.cancelBubble) {
        documentTarget.dispatchEvent(event);
        windowTarget.dispatchEvent(event);
      }

      expect(event.cancelBubble).toBe(true);
      expect(documentEvents).toBe(0);
      expect(windowEvents).toBe(0);
    });
  }
});

function snapshot(overrides: Partial<RunSubmissionSnapshot> = {}): RunSubmissionSnapshot {
  return {
    runId: 7,
    seed: 1264,
    rle: new Uint8Array([0, 1]),
    score: 500,
    stage: 2,
    runMode: 'normal',
    tainted: false,
    ...overrides,
  };
}

function board(scores: number[]): RankingEntry[] {
  return scores.map((score, i) => ({
    id: `e${i}`,
    createdAt: '2026-01-01T12:00:00Z',
    score,
    stage: 1,
    name: `N${i}`,
    xHandle: null,
    replayAvailable: true,
  }));
}

/** A full board whose 10th place is exactly `tenth`. */
function fullBoard(tenth: number): RankingEntry[] {
  return board(Array.from({ length: 10 }, (_, i) => tenth + (9 - i)));
}

function decide(args: Partial<Parameters<typeof decideSubmissionOffer>[0]> & { snapshot?: RunSubmissionSnapshot } = {}) {
  const snap = args.snapshot ?? snapshot();
  return decideSubmissionOffer({
    snapshot: snap,
    activeSnapshot: 'activeSnapshot' in args ? args.activeSnapshot! : snap,
    currentRunId: args.currentRunId ?? snap.runId,
    currentStatus: args.currentStatus ?? 'gameover',
    entries: 'entries' in args ? args.entries! : [],
  });
}

describe('isSnapshotEligible', () => {
  it('accepts a normal, untainted, seeded run', () => {
    expect(isSnapshotEligible(snapshot())).toBe(true);
  });

  it('rejects a ?seed= (seeded-mode) run', () => {
    expect(isSnapshotEligible(snapshot({ runMode: 'seeded' }))).toBe(false);
  });

  it('rejects a debug-tainted run', () => {
    expect(isSnapshotEligible(snapshot({ tainted: true }))).toBe(false);
  });

  it('rejects a run with no seed', () => {
    expect(isSnapshotEligible(snapshot({ seed: undefined }))).toBe(false);
  });
});

describe('decideSubmissionOffer: provisional in-range boundary', () => {
  it('shows the form when the board is not yet full, whatever the score', () => {
    expect(decide({ entries: [] })).toBe('show');
    expect(decide({ snapshot: snapshot({ score: 0 }), entries: board([9999, 9998]) })).toBe('show');
  });

  it('shows the form when a full board is strictly beaten', () => {
    expect(decide({ snapshot: snapshot({ score: 500 }), entries: fullBoard(499) })).toBe('show');
  });

  it('does NOT show the form when the score merely ties 10th place on a full board', () => {
    // First-come-first-served (rank_seq ASC): an equal score sorts behind the
    // incumbent, so it would land 11th and be trimmed away by POST itself.
    expect(decide({ snapshot: snapshot({ score: 500 }), entries: fullBoard(500) })).toBe('out-of-range');
  });

  it('does not show the form for a score below a full board', () => {
    expect(decide({ snapshot: snapshot({ score: 499 }), entries: fullBoard(500) })).toBe('out-of-range');
  });

  it('does not guess when the ranking fetch failed', () => {
    expect(decide({ entries: null })).toBe('fetch-failed');
  });
});

describe('decideSubmissionOffer: races against the response', () => {
  it('discards a response whose run has already been replaced by a newer gameover', () => {
    const older = snapshot({ runId: 7 });
    const newer = snapshot({ runId: 8 });
    expect(decide({ snapshot: older, activeSnapshot: newer, currentRunId: 8 })).toBe('superseded');
  });

  it('discards a response that outlived its run (GAME OVER -> Title while the GET was in flight)', () => {
    // The classic sequence: the run ends, the GET goes out, the player
    // presses a key and is back on Title (runId bumped) before it lands.
    const snap = snapshot({ runId: 7 });
    expect(decide({ snapshot: snap, currentRunId: 8, currentStatus: 'title' })).toBe('stale-run');
  });

  it('discards a response that lands once the run is no longer over, even if the run id somehow still matches', () => {
    const snap = snapshot({ runId: 7 });
    expect(decide({ snapshot: snap, currentRunId: 7, currentStatus: 'playing' })).toBe('run-no-longer-over');
  });

  it('discards a response for a snapshot the UI has already dropped (SKIP / hideAll cleared it)', () => {
    const snap = snapshot();
    expect(decide({ snapshot: snap, activeSnapshot: null })).toBe('superseded');
  });

  it('never shows the form for an ineligible run, whatever the board says', () => {
    for (const bad of [snapshot({ runMode: 'seeded' }), snapshot({ tainted: true }), snapshot({ seed: undefined })]) {
      expect(decide({ snapshot: bad, entries: [] })).toBe('ineligible-run');
    }
  });

  it('checks eligibility, supersession and staleness before the in-range comparison', () => {
    // A stale run that *would* have been in range is still discarded — the
    // ordering matters, since the whole point is that a stale "show" would
    // reopen the form for a run that no longer exists.
    const snap = snapshot({ runId: 7, score: 10_000 });
    expect(decide({ snapshot: snap, currentRunId: 9, currentStatus: 'title', entries: [] })).toBe('stale-run');
  });
});

describe('isReplayPayloadPlayable', () => {
  const RULESET = 3;
  const FORMAT = 2;
  const good = { seed: 1264, rleBase64: 'AAE=', rulesetVersion: RULESET, replayFormatVersion: FORMAT };

  it('accepts a payload matching this build exactly', () => {
    expect(isReplayPayloadPlayable(good, RULESET, FORMAT)).toBe(true);
  });

  it('rejects a ruleset this build does not implement (the stale-tab-across-a-deploy case)', () => {
    // The dangerous direction: the server considers this row current, but
    // THIS bundle's core is old, so replaying it would render a wrong run
    // rather than fail.
    expect(isReplayPayloadPlayable({ ...good, rulesetVersion: RULESET + 1 }, RULESET, FORMAT)).toBe(false);
    expect(isReplayPayloadPlayable({ ...good, rulesetVersion: RULESET - 1 }, RULESET, FORMAT)).toBe(false);
  });

  it('rejects a replay format this build cannot decode', () => {
    expect(isReplayPayloadPlayable({ ...good, replayFormatVersion: FORMAT + 1 }, RULESET, FORMAT)).toBe(false);
  });

  it('rejects a seed outside uint32, mirroring the server-side check', () => {
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY, '1264', null, undefined]) {
      expect(isReplayPayloadPlayable({ ...good, seed }, RULESET, FORMAT)).toBe(false);
    }
    for (const seed of [0, 0xffffffff]) {
      expect(isReplayPayloadPlayable({ ...good, seed }, RULESET, FORMAT)).toBe(true);
    }
  });

  it('rejects a missing/empty/non-string rleBase64 before it can reach the decoder', () => {
    for (const rleBase64 of ['', undefined, null, 42, {}]) {
      expect(isReplayPayloadPlayable({ ...good, rleBase64 }, RULESET, FORMAT)).toBe(false);
    }
  });

  it('rejects non-object payloads outright', () => {
    for (const payload of [null, undefined, 'nope', 42, []]) {
      // An array has no seed/rleBase64, so it fails the field checks too —
      // the point is that none of these throw.
      expect(isReplayPayloadPlayable(payload, RULESET, FORMAT)).toBe(false);
    }
  });
});

describe('formatRankingDate', () => {
  it('formats an ISO timestamp as YYYY-MM-DD', () => {
    // Built from local Date parts; noon UTC lands on the same calendar day
    // in every timezone this suite realistically runs in.
    const iso = '2026-03-04T12:00:00Z';
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(formatRankingDate(iso)).toBe(expected);
    expect(formatRankingDate(iso)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('degrades to an empty string rather than "Invalid Date"/"NaN-NaN-NaN"', () => {
    expect(formatRankingDate('not-a-date')).toBe('');
    expect(formatRankingDate('')).toBe('');
  });
});
