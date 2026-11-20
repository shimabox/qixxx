import { describe, expect, it } from 'vitest';
import {
  GameOverResult,
  GameOverRunTally,
  chooseGameOverHighlight,
  gameOverBestLine,
  gameOverHighlightText,
  type GameOverCue,
  type GameOverResultInput,
} from './gameOverResult';
import {
  GAMEOVER_COUNT_TICK_EVERY,
  GAMEOVER_HIGHLIGHT_DELAY_TICKS,
  GAMEOVER_RECORD_DELAY_TICKS,
} from './config';

const TIMING = { countTicks: 42, popTicks: 8, sparkTicks: 30 };

function input(over: Partial<GameOverResultInput> = {}): GameOverResultInput {
  return {
    score: 12345,
    stage: 1,
    bestAtStart: 0,
    recordsHighScore: true,
    tally: { splits: 0, claims: 1, bestShare: 0.04 },
    reducedMotion: false,
    timing: TIMING,
    ...over,
  };
}

/** Starts a result and steps it `ticks` times, collecting every cue with the age it came at. */
function run(result: GameOverResult, given: GameOverResultInput, ticks: number) {
  const cues: Array<{ age: number; cue: GameOverCue }> = [];
  const scores: number[] = [];
  for (const cue of result.start(given)) cues.push({ age: 0, cue });
  scores.push(result.view().score);
  for (let age = 1; age <= ticks; age++) {
    for (const cue of result.step()) cues.push({ age, cue });
    scores.push(result.view().score);
  }
  return { cues, scores };
}

describe('GameOverResult — the score count-up', () => {
  it('counts from 0 to the final score over the count ticks, never falling and never past it', () => {
    const result = new GameOverResult();
    const { scores } = run(result, input(), 80);
    expect(scores[0]).toBe(0);
    expect(scores[TIMING.countTicks]).toBe(12345);
    expect(scores[TIMING.countTicks - 1]).toBeLessThan(12345);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      expect(scores[i]).toBeLessThanOrEqual(12345);
    }
    // Ease-out: more than half way by the middle.
    expect(scores[TIMING.countTicks / 2]).toBeGreaterThan(12345 / 2);
    expect(result.view().finished).toBe(true);
  });

  it('ticks every GAMEOVER_COUNT_TICK_EVERY ticks while counting, and stops once', () => {
    const { cues } = run(new GameOverResult(), input({ bestAtStart: 99999 }), 120);
    const ticks = cues.filter((c) => c.cue === 'count-tick').map((c) => c.age);
    expect(ticks.length).toBeGreaterThan(5);
    for (const age of ticks) {
      expect(age % GAMEOVER_COUNT_TICK_EVERY).toBe(0);
      expect(age).toBeGreaterThan(0);
      expect(age).toBeLessThan(TIMING.countTicks);
    }
    expect(ticks).toEqual(ticks.map((_, i) => (i + 1) * GAMEOVER_COUNT_TICK_EVERY));
    expect(cues.filter((c) => c.cue === 'count-end')).toEqual([{ age: TIMING.countTicks, cue: 'count-end' }]);
  });

  it('a score of 0 shows 0 at once: no count, no tick, no stop', () => {
    const result = new GameOverResult();
    const { cues, scores } = run(result, input({ score: 0, tally: { splits: 0, claims: 0, bestShare: 0 } }), 120);
    expect(scores.every((s) => s === 0)).toBe(true);
    expect(cues).toEqual([]);
    expect(result.view().finished).toBe(true);
    expect(result.view().popScale).toBe(1);
  });

  it('pops the score from GAMEOVER_POP_SCALE back to 1 when the count stops', () => {
    const result = new GameOverResult();
    result.start(input());
    const scales: number[] = [result.view().popScale];
    for (let i = 0; i < 60; i++) {
      result.step();
      scales.push(result.view().popScale);
    }
    expect(scales[TIMING.countTicks - 1]).toBe(1);
    expect(scales[TIMING.countTicks]).toBeCloseTo(1.25, 9);
    expect(scales[TIMING.countTicks + TIMING.popTicks]).toBe(1);
    for (let i = TIMING.countTicks + 1; i <= TIMING.countTicks + TIMING.popTicks; i++) {
      expect(scales[i]).toBeLessThanOrEqual(scales[i - 1]);
    }
  });
});

describe('GameOverResult — the lines after the count', () => {
  it('shows the highlight GAMEOVER_HIGHLIGHT_DELAY_TICKS after the stop, the best line GAMEOVER_RECORD_DELAY_TICKS after it', () => {
    const result = new GameOverResult();
    result.start(input({ bestAtStart: 20000 }));
    const at: Array<{ highlight: boolean; best: boolean }> = [];
    at.push({ highlight: result.view().highlightShown, best: result.view().bestLineShown });
    for (let i = 0; i < 80; i++) {
      result.step();
      at.push({ highlight: result.view().highlightShown, best: result.view().bestLineShown });
    }
    const end = TIMING.countTicks;
    expect(at[end + GAMEOVER_HIGHLIGHT_DELAY_TICKS - 1].highlight).toBe(false);
    expect(at[end + GAMEOVER_HIGHLIGHT_DELAY_TICKS].highlight).toBe(true);
    expect(at[end + GAMEOVER_RECORD_DELAY_TICKS - 1].best).toBe(false);
    expect(at[end + GAMEOVER_RECORD_DELAY_TICKS].best).toBe(true);
    expect(at[80]).toEqual({ highlight: true, best: true });
  });

  it('a beaten best: the NEW RECORD cue once, with the record pop and the sparks', () => {
    const result = new GameOverResult();
    const recordAge = TIMING.countTicks + GAMEOVER_RECORD_DELAY_TICKS;
    result.start(input({ bestAtStart: 10000 }));
    const cues: Array<{ age: number; cue: GameOverCue }> = [];
    let sparkSeen = false;
    for (let age = 1; age <= 150; age++) {
      for (const cue of result.step()) cues.push({ age, cue });
      if (age === recordAge) {
        expect(result.view().recordPopScale).toBeCloseTo(1.25, 9);
        expect(result.view().sparkProgress).toBe(0);
      }
      if (result.view().sparkProgress !== null) sparkSeen = true;
    }
    expect(cues.filter((c) => c.cue === 'new-record')).toEqual([{ age: recordAge, cue: 'new-record' }]);
    expect(sparkSeen).toBe(true);
    expect(result.view().sparkProgress).toBeNull();
    expect(result.view().bestLine).toEqual({ kind: 'new-record', delta: 2345 });
  });

  it('a first run (best 0) with points still sets a NEW RECORD; with no points neither line shows', () => {
    const first = new GameOverResult();
    const { cues } = run(first, input({ bestAtStart: 0, score: 50 }), 120);
    expect(cues.filter((c) => c.cue === 'new-record')).toHaveLength(1);
    expect(first.view().bestLine).toEqual({ kind: 'new-record', delta: 50 });

    const none = new GameOverResult();
    const zero = run(none, input({ bestAtStart: 0, score: 0, tally: { splits: 0, claims: 0, bestShare: 0 } }), 120);
    expect(zero.cues).toEqual([]);
    expect(none.view().bestLine).toBeNull();
  });

  it('a best not beaten: the distance to it, near within 10%, and no NEW RECORD cue', () => {
    expect(gameOverBestLine({ score: 9500, bestAtStart: 10000, recordsHighScore: true })).toEqual({
      kind: 'to-best',
      gap: 500,
      near: true,
    });
    expect(gameOverBestLine({ score: 9000, bestAtStart: 10000, recordsHighScore: true })).toEqual({
      kind: 'to-best',
      gap: 1000,
      near: true,
    });
    expect(gameOverBestLine({ score: 8999, bestAtStart: 10000, recordsHighScore: true })).toEqual({
      kind: 'to-best',
      gap: 1001,
      near: false,
    });
    const { cues } = run(new GameOverResult(), input({ score: 9500, bestAtStart: 10000 }), 120);
    expect(cues.some((c) => c.cue === 'new-record')).toBe(false);
  });

  it('a run that saves no high score shows neither line', () => {
    for (const score of [0, 50, 20000]) {
      expect(gameOverBestLine({ score, bestAtStart: 10000, recordsHighScore: false })).toBeNull();
      expect(gameOverBestLine({ score, bestAtStart: 0, recordsHighScore: false })).toBeNull();
    }
    const { cues } = run(new GameOverResult(), input({ recordsHighScore: false, bestAtStart: 0 }), 120);
    expect(cues.some((c) => c.cue === 'new-record')).toBe(false);
    // The count and its sounds still run.
    expect(cues.some((c) => c.cue === 'count-tick')).toBe(true);
  });
});

describe('the run highlight', () => {
  it('picks the first that applies: splits, a claim of 20% or more, the stage reached, then any claim', () => {
    expect(chooseGameOverHighlight({ splits: 2, claims: 5, bestShare: 0.5 }, 4)).toEqual({ kind: 'split', splits: 2 });
    expect(chooseGameOverHighlight({ splits: 0, claims: 5, bestShare: 0.234 }, 4)).toEqual({ kind: 'bestClaim', percent: 23 });
    expect(chooseGameOverHighlight({ splits: 0, claims: 5, bestShare: 0.2 }, 1)).toEqual({ kind: 'bestClaim', percent: 20 });
    expect(chooseGameOverHighlight({ splits: 0, claims: 5, bestShare: 0.19 }, 3)).toEqual({ kind: 'stage', stage: 3 });
    expect(chooseGameOverHighlight({ splits: 0, claims: 2, bestShare: 0.126 }, 1)).toEqual({ kind: 'bestClaim', percent: 13 });
    expect(chooseGameOverHighlight({ splits: 0, claims: 1, bestShare: 0.003 }, 1)).toEqual({ kind: 'bestClaim', percent: 1 });
    expect(chooseGameOverHighlight({ splits: 0, claims: 0, bestShare: 0 }, 1)).toBeNull();
  });

  it('reads as designed', () => {
    expect(gameOverHighlightText({ kind: 'split', splits: 3 })).toBe('SPLIT ×3');
    expect(gameOverHighlightText({ kind: 'bestClaim', percent: 23 })).toBe('BEST CLAIM 23%');
    expect(gameOverHighlightText({ kind: 'stage', stage: 2 })).toBe('REACHED STAGE 2');
  });

  it('is collected from the claim notices and starts over with a run', () => {
    const tally = new GameOverRunTally();
    tally.add({ occupancyBefore: 0, occupancyAfter: 0.05, split: false });
    tally.add({ occupancyBefore: 0.05, occupancyAfter: 0.17, split: false });
    tally.add({ occupancyBefore: 0.17, occupancyAfter: 0.2, split: true });
    expect(tally.snapshot()).toEqual({ splits: 1, claims: 3, bestShare: expect.closeTo(0.12, 9) });
    tally.reset();
    expect(tally.snapshot()).toEqual({ splits: 0, claims: 0, bestShare: 0 });
  });

  it('a result with no highlight never shows one', () => {
    const result = new GameOverResult();
    run(result, input({ tally: { splits: 0, claims: 0, bestShare: 0 } }), 120);
    expect(result.view().highlight).toBeNull();
  });
});

describe('GameOverResult — reduced motion and stopping', () => {
  it('reduced motion: the final display from the first tick, and no count cues', () => {
    const result = new GameOverResult();
    const cues = [...result.start(input({ reducedMotion: true, bestAtStart: 100 }))];
    const v = result.view();
    expect(v.score).toBe(12345);
    expect(v.finished).toBe(true);
    expect(v.highlightShown).toBe(true);
    expect(v.bestLineShown).toBe(true);
    expect(v.popScale).toBe(1);
    expect(v.recordPopScale).toBe(1);
    expect(v.sparkProgress).toBeNull();
    for (let i = 0; i < 120; i++) {
      cues.push(...result.step());
      expect(result.view().sparkProgress).toBeNull();
      expect(result.view().score).toBe(12345);
    }
    expect(cues).not.toContain('count-tick');
    expect(cues).not.toContain('count-end');
  });

  it('reduced motion: a beaten best shows NEW RECORD from the first tick, and its fanfare plays once, GAMEOVER_RECORD_DELAY_TICKS after the modal appears', () => {
    const result = new GameOverResult();
    const { cues } = run(result, input({ reducedMotion: true, bestAtStart: 100 }), 120);
    expect(cues.filter((c) => c.cue === 'new-record')).toEqual([{ age: GAMEOVER_RECORD_DELAY_TICKS, cue: 'new-record' }]);
    const again = new GameOverResult();
    again.start(input({ reducedMotion: true, bestAtStart: 100 }));
    expect(again.view()).toMatchObject({ bestLine: { kind: 'new-record', delta: 12245 }, bestLineShown: true });
  });

  it('reduced motion: a best not beaten plays no fanfare', () => {
    const result = new GameOverResult();
    const { cues } = run(result, input({ reducedMotion: true, bestAtStart: 99999 }), 120);
    expect(cues).toEqual([]);
  });

  it('stopping part way gives no further cue', () => {
    const result = new GameOverResult();
    result.start(input({ bestAtStart: 100 }));
    for (let i = 0; i < 10; i++) result.step();
    result.stop();
    expect(result.view().active).toBe(false);
    for (let i = 0; i < 200; i++) expect(result.step()).toEqual([]);
  });

  it('is inactive before its first start', () => {
    const result = new GameOverResult();
    expect(result.view().active).toBe(false);
    expect(result.step()).toEqual([]);
  });
});
