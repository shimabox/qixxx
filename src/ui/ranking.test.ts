// Pure (DOM-free) half of the ranking submission flow: eligibility, the
// provisional-in-range boundary, and the async races between "ask the server
// for the current top 10" and "the player has already moved on".
//
// Only the pure exports of src/ui/ranking.ts are imported here — initRankingUI()
// itself is DOM-bound and is covered by tests/e2e/ranking.spec.ts instead
// (vitest runs in the `node` environment for this repo; see vitest.config.ts).
import { describe, it, expect } from 'vitest';
import {
  acceptedSubmissionText,
  boardNotice,
  decideSubmissionOffer,
  DeferredSubmissionOffer,
  demoCandidateIdsFrom,
  isSnapshotEligible,
  isReplayPayloadPlayable,
  formatRankingDate,
  limitRankingName,
  rankInThresholdFrom,
  RankInThresholdTracker,
  stopKeyPropagation,
  type RankingEntry,
  type RunSubmissionSnapshot,
} from './ranking';
import { GAMEOVER_RECORD_DELAY_TICKS, MAX_VERIFIED_CLAIMS, RANKING_OFFER_DELAY_TICKS } from '../config';
import { GameOverResult, type GameOverResultInput } from '../gameOverResult';

describe('acceptedSubmissionText', () => {
  it('says plainly SUBMITTED for a row the server stored as verified (no audit)', () => {
    expect(acceptedSubmissionText('verified')).toBe('SUBMITTED.');
  });

  it('keeps the pending-verification line for a pending row', () => {
    expect(acceptedSubmissionText('pending')).toBe('SUBMITTED — PENDING VERIFICATION.');
  });

  it('falls back to the pending-verification line when the status is missing or unrecognized', () => {
    for (const status of [undefined, null, '', 'VERIFIED', 42]) {
      expect(acceptedSubmissionText(status)).toBe('SUBMITTED — PENDING VERIFICATION.');
    }
  });
});

describe('boardNotice', () => {
  it('discloses both board rules without claiming every score is verified', () => {
    expect(boardNotice()).toContain('X handles are self-reported');
    expect(boardNotice()).toContain('may be removed');
    expect(boardNotice()).not.toMatch(/scores are verified/i);
  });
});

describe('limitRankingName', () => {
  it('allows 24 emoji code points and removes the 25th', () => {
    const emoji = '🚀';
    expect(limitRankingName(emoji.repeat(24))).toBe(emoji.repeat(24));
    expect(limitRankingName(emoji.repeat(25))).toBe(emoji.repeat(24));
  });

  it('allows 24 ASCII characters as before', () => {
    const ascii = 'a'.repeat(24);
    expect(limitRankingName(ascii)).toBe(ascii);
  });
});

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
    difficulty: 'normal',
    claims: 3,
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

  it('rejects an EASY run, however clean otherwise', () => {
    expect(isSnapshotEligible(snapshot({ difficulty: 'easy' }))).toBe(false);
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

describe('rankInThresholdFrom', () => {
  it('is 0 while the board has a free row, so any score gets in', () => {
    expect(rankInThresholdFrom([])).toBe(0);
    expect(rankInThresholdFrom(board([9999, 9998]))).toBe(0);
  });

  it('is the lowest row on a full board, agreeing with the offer boundary', () => {
    expect(rankInThresholdFrom(fullBoard(500))).toBe(500);
    expect(decide({ snapshot: snapshot({ score: rankInThresholdFrom(fullBoard(500)) }), entries: fullBoard(500) })).toBe('out-of-range');
    expect(decide({ snapshot: snapshot({ score: rankInThresholdFrom(fullBoard(500)) + 1 }), entries: fullBoard(500) })).toBe('show');
  });
});

describe('demoCandidateIdsFrom', () => {
  const row = (id: string, replayAvailable: boolean) => ({ id, replayAvailable });

  it('takes the replayable rows from the top of the board, in board order, up to the limit', () => {
    const entries = [row('a', true), row('b', false), row('c', true), row('d', true), row('e', true)];
    expect(demoCandidateIdsFrom(entries, 3)).toEqual(['a', 'c', 'd']);
  });

  it('returns fewer when fewer rows are replayable, and none for an empty board or no replays', () => {
    expect(demoCandidateIdsFrom([row('a', false), row('b', true)], 3)).toEqual(['b']);
    expect(demoCandidateIdsFrom([], 3)).toEqual([]);
    expect(demoCandidateIdsFrom([row('a', false), row('b', false)], 3)).toEqual([]);
  });
});

describe('RankInThresholdTracker', () => {
  it('is null until a request succeeds', () => {
    const tracker = new RankInThresholdTracker();
    expect(tracker.get()).toBeNull();
    tracker.settle(tracker.begin(), null);
    expect(tracker.get()).toBeNull();
  });

  it('keeps the newer value when the earlier request answers last', () => {
    const tracker = new RankInThresholdTracker();
    const pageLoad = tracker.begin();
    const gameOver = tracker.begin();
    tracker.settle(gameOver, fullBoard(700));
    tracker.settle(pageLoad, fullBoard(500));
    expect(tracker.get()).toBe(700);
  });

  it('takes the newer value when the replies land in order', () => {
    const tracker = new RankInThresholdTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    tracker.settle(first, fullBoard(500));
    expect(tracker.get()).toBe(500);
    tracker.settle(second, fullBoard(700));
    expect(tracker.get()).toBe(700);
  });

  it('never clears a known value on a failed reply, older or newer', () => {
    const tracker = new RankInThresholdTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    tracker.settle(first, fullBoard(500));
    tracker.settle(second, null);
    expect(tracker.get()).toBe(500);
    // A later success still writes after a failed newer request.
    tracker.settle(tracker.begin(), []);
    expect(tracker.get()).toBe(0);
  });
});

describe('decideSubmissionOffer: verification claim cap', () => {
  it('explains instead of offering when an in-range run exceeds MAX_VERIFIED_CLAIMS', () => {
    expect(decide({ snapshot: snapshot({ claims: MAX_VERIFIED_CLAIMS + 1 }), entries: [] })).toBe('over-claim-cap');
    expect(decide({ snapshot: snapshot({ score: 500, claims: MAX_VERIFIED_CLAIMS + 1 }), entries: fullBoard(499) })).toBe('over-claim-cap');
  });

  it('offers a run exactly at the cap — the audit rejects only the claim past it', () => {
    expect(decide({ snapshot: snapshot({ claims: MAX_VERIFIED_CLAIMS }), entries: [] })).toBe('show');
  });

  it('stays silent for an out-of-range run whatever its claim count', () => {
    expect(decide({ snapshot: snapshot({ score: 499, claims: MAX_VERIFIED_CLAIMS + 1 }), entries: fullBoard(500) })).toBe('out-of-range');
  });

  it('never explains a run that was ineligible or stale to begin with', () => {
    expect(decide({ snapshot: snapshot({ tainted: true, claims: MAX_VERIFIED_CLAIMS + 1 }), entries: [] })).toBe('ineligible-run');
    expect(decide({ snapshot: snapshot({ claims: MAX_VERIFIED_CLAIMS + 1 }), currentStatus: 'playing', entries: [] })).toBe('run-no-longer-over');
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
    for (const bad of [snapshot({ runMode: 'seeded' }), snapshot({ tainted: true }), snapshot({ seed: undefined }), snapshot({ difficulty: 'easy' })]) {
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

describe('DeferredSubmissionOffer: the panel opens once the GAME OVER result has been read', () => {
  const TIMING = { countTicks: 42, popTicks: 8, sparkTicks: 30 };
  const resultInput = (over: Partial<GameOverResultInput> = {}): GameOverResultInput => ({
    score: 12345,
    stage: 1,
    bestAtStart: 100,
    recordsHighScore: true,
    tally: { splits: 0, claims: 1, bestShare: 0.04 },
    reducedMotion: false,
    timing: TIMING,
    ...over,
  });

  /**
   * A GAME OVER screen one tick per frame: the reply decides on frame
   * `replyAge` (before that frame's sync, as an async reply lands between
   * frames). Returns the age the panel opened at, and the ages it was waiting.
   */
  function play(given: GameOverResultInput, replyAge: number, frames = 400) {
    const result = new GameOverResult();
    result.start(given);
    const offer = new DeferredSubmissionOffer(() => result.isSubmissionOfferDue());
    let openedAt: number | null = null;
    const waitingAges: number[] = [];
    for (let age = 0; age <= frames && openedAt === null; age++) {
      if (age > 0) result.step();
      if (age === replyAge) offer.decide(() => (openedAt = result.getAge()));
      offer.sync();
      if (offer.isWaiting()) waitingAges.push(age);
    }
    return { openedAt, waitingAges, offerAge: result.submissionOfferAge(), lastLineAge: result.lastLineAge() };
  }

  it('a reply in time: opens RANKING_OFFER_DELAY_TICKS after the last line is due, waiting from the reply until then', () => {
    const { openedAt, waitingAges, lastLineAge } = play(resultInput(), 3);
    expect(openedAt).toBe(lastLineAge + RANKING_OFFER_DELAY_TICKS);
    expect(waitingAges[0]).toBe(3);
    expect(waitingAges[waitingAges.length - 1]).toBe(lastLineAge + RANKING_OFFER_DELAY_TICKS - 1);
    expect(waitingAges).toHaveLength(lastLineAge + RANKING_OFFER_DELAY_TICKS - 3);
  });

  it('a reply after that time: opens as it lands, with no wait', () => {
    const offerAge = play(resultInput(), 0).offerAge;
    const { openedAt, waitingAges } = play(resultInput(), offerAge + 25);
    expect(openedAt).toBe(offerAge + 25);
    expect(waitingAges).toEqual([]);
  });

  it('a score of 0 (an empty board) and reduced motion: from their own last-line time', () => {
    const zero = play(resultInput({ score: 0, bestAtStart: 0, tally: { splits: 0, claims: 0, bestShare: 0 } }), 1);
    expect(zero.lastLineAge).toBe(GAMEOVER_RECORD_DELAY_TICKS);
    expect(zero.openedAt).toBe(GAMEOVER_RECORD_DELAY_TICKS + RANKING_OFFER_DELAY_TICKS);
    const still = play(resultInput({ reducedMotion: true }), 1);
    expect(still.lastLineAge).toBe(0);
    expect(still.openedAt).toBe(RANKING_OFFER_DELAY_TICKS);
  });

  it('several ticks per frame: opens on the first frame past the time, not later', () => {
    const result = new GameOverResult();
    result.start(resultInput());
    const offer = new DeferredSubmissionOffer(() => result.isSubmissionOfferDue());
    let openedAt: number | null = null;
    offer.decide(() => (openedAt = result.getAge()));
    const due = result.submissionOfferAge();
    while (openedAt === null && result.getAge() < 400) {
      for (let i = 0; i < 5; i++) result.step();
      offer.sync();
      if (openedAt === null) expect(result.getAge()).toBeLessThan(due);
    }
    expect(openedAt).toBe(Math.ceil(due / 5) * 5);
  });

  it('cancel() — the run left GAME OVER, or a new offer took over — means it never opens', () => {
    const result = new GameOverResult();
    result.start(resultInput());
    const offer = new DeferredSubmissionOffer(() => result.isSubmissionOfferDue());
    let opened = 0;
    offer.decide(() => opened++);
    expect(offer.isWaiting()).toBe(true);
    offer.cancel();
    expect(offer.isWaiting()).toBe(false);
    for (let i = 0; i < 400; i++) {
      result.step();
      offer.sync();
    }
    expect(opened).toBe(0);
  });

  it('a stopped result (TITLE, a retry) is never due: a reply landing after it opens nothing', () => {
    const result = new GameOverResult();
    result.start(resultInput({ timing: { ...TIMING, offerDelayTicks: 0 } }));
    for (let i = 0; i < 200; i++) result.step();
    result.stop();
    const offer = new DeferredSubmissionOffer(() => result.isSubmissionOfferDue());
    let opened = 0;
    offer.decide(() => opened++);
    offer.sync();
    expect(opened).toBe(0);
  });

  it('a newer decision replaces a waiting one; each opens at most once', () => {
    let due = false;
    const offer = new DeferredSubmissionOffer(() => due);
    const opened: string[] = [];
    offer.decide(() => opened.push('a'));
    offer.decide(() => opened.push('b'));
    offer.sync();
    expect(opened).toEqual([]);
    due = true;
    offer.sync();
    offer.sync();
    expect(opened).toEqual(['b']);
    expect(offer.isWaiting()).toBe(false);
  });
});
