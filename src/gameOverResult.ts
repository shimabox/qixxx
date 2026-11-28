// The live GAME OVER result: the score counting up from 0 when the modal
// appears, its pop when it stops, the run's one highlight, and NEW RECORD or
// the distance to the best — with the sound cue each tick calls for. Pure and
// tick-driven (no DOM, no clock, no Math.random), like src/stageResult.ts, so
// the timeline has direct unit test coverage (src/gameOverResult.test.ts).
// src/ui/gameOverModal.ts only draws what view() returns; src/main.ts plays
// the cues. Display only: the X share and the ranking read the session's
// final score, never the counting one, and nothing here holds the retry. The
// ranking submission panel waits for it: submissionOfferAge() is when the
// panel may open over it.
import {
  FX_CLAIM_SHARE_LARGE,
  GAMEOVER_COUNT_TICK_EVERY,
  GAMEOVER_HIGHLIGHT_DELAY_TICKS,
  GAMEOVER_NEAR_BEST_RATIO,
  GAMEOVER_POP_SCALE,
  GAMEOVER_RECORD_DELAY_TICKS,
  RANKING_OFFER_DELAY_TICKS,
} from './config';
import { t } from './i18n';

/** The parts of a claim notice (core/feedback.ts's ClaimFeedback) the highlight is chosen from. */
export interface GameOverClaimNotice {
  occupancyBefore: number;
  occupancyAfter: number;
  split: boolean;
}

export interface GameOverTallySnapshot {
  splits: number;
  claims: number;
  /** The largest occupancy one claim added (0-1). */
  bestShare: number;
}

/** What one live run did, from its claim notices. Reset when a run starts. */
export class GameOverRunTally {
  private splits = 0;
  private claims = 0;
  private bestShare = 0;

  add(notice: GameOverClaimNotice): void {
    this.claims++;
    if (notice.split) this.splits++;
    this.bestShare = Math.max(this.bestShare, notice.occupancyAfter - notice.occupancyBefore);
  }

  reset(): void {
    this.splits = 0;
    this.claims = 0;
    this.bestShare = 0;
  }

  snapshot(): GameOverTallySnapshot {
    return { splits: this.splits, claims: this.claims, bestShare: this.bestShare };
  }
}

export type GameOverHighlight =
  | { kind: 'split'; splits: number }
  | { kind: 'bestClaim'; percent: number }
  | { kind: 'stage'; stage: number };

/**
 * The run's one highlight: the first that applies of a split, a claim of
 * FX_CLAIM_SHARE_LARGE or more, a stage past the first, any claim at all
 * (at least 1%). Null for a run that did none of these.
 */
export function chooseGameOverHighlight(tally: GameOverTallySnapshot, stage: number): GameOverHighlight | null {
  if (tally.splits > 0) return { kind: 'split', splits: tally.splits };
  const percent = Math.round(tally.bestShare * 100);
  if (tally.claims > 0 && tally.bestShare >= FX_CLAIM_SHARE_LARGE) return { kind: 'bestClaim', percent };
  if (stage >= 2) return { kind: 'stage', stage };
  if (tally.claims > 0) return { kind: 'bestClaim', percent: Math.max(1, percent) };
  return null;
}

export function gameOverHighlightText(highlight: GameOverHighlight): string {
  switch (highlight.kind) {
    case 'split':
      return t('gameOver.highlight.split', highlight.splits);
    case 'bestClaim':
      return t('gameOver.highlight.bestClaim', highlight.percent);
    case 'stage':
      return t('gameOver.highlight.stage', highlight.stage);
  }
}

export type GameOverBestLine = { kind: 'new-record'; delta: number } | { kind: 'to-best'; gap: number; near: boolean };

/**
 * NEW RECORD for a run that may save its high score and beat the best it
 * started from (a first run's best is 0, so any point beats it); otherwise,
 * for such a run with a best to chase, how far short it fell — `near` within
 * GAMEOVER_NEAR_BEST_RATIO of that best. Null for a run that saves no high
 * score (`?seed=`, a debug override) and for a first run with no points.
 */
export function gameOverBestLine(input: {
  score: number;
  bestAtStart: number;
  recordsHighScore: boolean;
}): GameOverBestLine | null {
  if (!input.recordsHighScore) return null;
  if (input.score > input.bestAtStart) return { kind: 'new-record', delta: input.score - input.bestAtStart };
  if (input.bestAtStart < 1) return null;
  const gap = input.bestAtStart - input.score;
  return { kind: 'to-best', gap, near: gap <= input.bestAtStart * GAMEOVER_NEAR_BEST_RATIO };
}

export type GameOverCue = 'count-tick' | 'count-end' | 'new-record';

export interface GameOverTiming {
  countTicks: number;
  popTicks: number;
  sparkTicks: number;
  /**
   * The ranking submission panel may open this many ticks after the last
   * line is due (submissionOfferAge()). RANKING_OFFER_DELAY_TICKS when omitted.
   */
  offerDelayTicks?: number;
}

export interface GameOverResultInput {
  /** The run's final score (the session's). */
  score: number;
  stage: number;
  /** The best the run started from. */
  bestAtStart: number;
  /** The run may save its high score (a normal run with no debug override). */
  recordsHighScore: boolean;
  /**
   * The screen suggests EASY (src/playLog/summary.ts's suggestsEasy()): the
   * suggestion takes the highlight's place and timing, and the run's
   * highlight is not shown. Default false.
   */
  easyPrompt?: boolean;
  tally: GameOverTallySnapshot;
  /** prefers-reduced-motion: the final display at once, no count. */
  reducedMotion: boolean;
  timing: GameOverTiming;
}

export interface GameOverResultView {
  /** Started and not stopped since. */
  active: boolean;
  /** The score to show now. */
  score: number;
  /** The count has reached the final score. */
  finished: boolean;
  /** The score's scale (1 outside its pop). */
  popScale: number;
  highlight: GameOverHighlight | null;
  highlightShown: boolean;
  /** The EASY suggestion is shown in the highlight's place (`highlight` is then null). */
  prompt: boolean;
  /** The suggestion is due — when a highlight would show. */
  promptShown: boolean;
  bestLine: GameOverBestLine | null;
  bestLineShown: boolean;
  /** NEW RECORD's scale (1 outside its pop). */
  recordPopScale: number;
  /** The sparks around NEW RECORD, 0 to 1 while they fly, else null. */
  sparkProgress: number | null;
}

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

/** From `scale` back to 1 over `ticks`, `age` ticks in. */
function popAt(age: number, ticks: number): number {
  if (age < 0 || ticks <= 0 || age >= ticks) return 1;
  return GAMEOVER_POP_SCALE + (1 - GAMEOVER_POP_SCALE) * (age / ticks);
}

/**
 * The timeline, from the tick the modal appears (age 0): the count over
 * `countTicks` with a tick cue every GAMEOVER_COUNT_TICK_EVERY, the stop cue
 * and the pop when it ends, the highlight GAMEOVER_HIGHLIGHT_DELAY_TICKS
 * later, the best line (and the NEW RECORD cue, pop and sparks)
 * GAMEOVER_RECORD_DELAY_TICKS later. A score of 0 has no count and no count
 * cues. Reduced motion shows everything final at once (the best line
 * included), with no count cues; a beaten best's fanfare still plays,
 * GAMEOVER_RECORD_DELAY_TICKS after the modal appears (there is no count to
 * wait for). stop() (a retry, Title, a replay) ends it: no cue after that.
 */
export class GameOverResult {
  private input: GameOverResultInput | null = null;
  private age = 0;
  private highlight: GameOverHighlight | null = null;
  private bestLine: GameOverBestLine | null = null;

  /** Starts on the tick the modal appears; returns that tick's cues. */
  start(input: GameOverResultInput): GameOverCue[] {
    this.input = { ...input, timing: { ...input.timing } };
    this.age = 0;
    // The EASY suggestion takes the highlight's place.
    this.highlight = input.easyPrompt ? null : chooseGameOverHighlight(input.tally, input.stage);
    this.bestLine = gameOverBestLine(input);
    return this.cuesAt(0);
  }

  /** One live tick on; returns the new tick's cues. */
  step(): GameOverCue[] {
    if (!this.input) return [];
    this.age++;
    return this.cuesAt(this.age);
  }

  stop(): void {
    this.input = null;
  }

  isActive(): boolean {
    return this.input !== null;
  }

  /** The ticks since the modal appeared (0 on that tick). */
  getAge(): number {
    return this.age;
  }

  /**
   * The age the last line — the best line — is due at: after the count and
   * GAMEOVER_RECORD_DELAY_TICKS, sooner for a score of 0 (no count), 0 under
   * reduced motion (everything shows at once). The same for a run that shows
   * no best line: the time it would show.
   */
  lastLineAge(): number {
    return this.recordAge();
  }

  /**
   * The age from which the ranking submission panel may open: the timing's
   * offerDelayTicks after lastLineAge(). Counted from when the last line is
   * due, not from the frame that first draws it, so it is the same tick
   * however many ticks a frame runs.
   */
  submissionOfferAge(): number {
    const delay = this.input?.timing.offerDelayTicks ?? RANKING_OFFER_DELAY_TICKS;
    return this.lastLineAge() + Math.max(0, Math.round(delay));
  }

  /** Started, and submissionOfferAge() has been reached. */
  isSubmissionOfferDue(): boolean {
    return this.input !== null && this.age >= this.submissionOfferAge();
  }

  view(): GameOverResultView {
    const input = this.input;
    if (!input) {
      return {
        active: false,
        score: 0,
        finished: false,
        popScale: 1,
        highlight: null,
        highlightShown: false,
        prompt: false,
        promptShown: false,
        bestLine: null,
        bestLineShown: false,
        recordPopScale: 1,
        sparkProgress: null,
      };
    }
    const end = this.countEndAge();
    const counts = this.counts();
    const finished = !counts || this.age >= end;
    const score = finished ? input.score : Math.floor(input.score * easeOutCubic(this.age / end));
    const recordAge = this.recordAge();
    const motion = !input.reducedMotion;
    const newRecord = this.bestLine?.kind === 'new-record';
    const sparkAge = this.age - recordAge;
    return {
      active: true,
      score: Math.min(input.score, Math.max(0, score)),
      finished,
      popScale: counts && motion ? popAt(this.age - end, input.timing.popTicks) : 1,
      highlight: this.highlight,
      highlightShown: this.highlight !== null && this.age >= this.highlightAge(),
      prompt: input.easyPrompt === true,
      promptShown: input.easyPrompt === true && this.age >= this.highlightAge(),
      bestLine: this.bestLine,
      bestLineShown: this.bestLine !== null && this.age >= recordAge,
      recordPopScale: newRecord && motion ? popAt(sparkAge, input.timing.popTicks) : 1,
      sparkProgress:
        newRecord && motion && sparkAge >= 0 && sparkAge < input.timing.sparkTicks
          ? sparkAge / input.timing.sparkTicks
          : null,
    };
  }

  // The score counts up: points to count and motion allowed.
  private counts(): boolean {
    return this.input !== null && this.input.score > 0 && !this.input.reducedMotion;
  }

  private countEndAge(): number {
    return this.counts() ? Math.max(0, Math.round(this.input!.timing.countTicks)) : 0;
  }

  private highlightAge(): number {
    if (this.input?.reducedMotion) return 0;
    return this.countEndAge() + GAMEOVER_HIGHLIGHT_DELAY_TICKS;
  }

  private recordAge(): number {
    if (this.input?.reducedMotion) return 0;
    return this.countEndAge() + GAMEOVER_RECORD_DELAY_TICKS;
  }

  private cuesAt(age: number): GameOverCue[] {
    const cues: GameOverCue[] = [];
    if (this.counts()) {
      const end = this.countEndAge();
      if (age > 0 && age < end && age % GAMEOVER_COUNT_TICK_EVERY === 0) cues.push('count-tick');
      if (age === end) cues.push('count-end');
    }
    // The fanfare plays GAMEOVER_RECORD_DELAY_TICKS after the count ends —
    // with reduced motion (no count), that many ticks after the modal appears,
    // though the NEW RECORD line shows from the start: sounds are not motion,
    // only the display is final from the start.
    const fanfareAge = this.countEndAge() + GAMEOVER_RECORD_DELAY_TICKS;
    if (this.bestLine?.kind === 'new-record' && age === fanfareAge) cues.push('new-record');
    return cues;
  }
}
