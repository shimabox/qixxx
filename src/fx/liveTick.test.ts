// The live tick's hit stop and confirm holds, driven exactly the way
// src/main.ts drives them (beginLiveTick -> GameSession.update ->
// InputRecorder.observe -> applyImpactNotices, plus the render-time GAME
// OVER modal decision), with a real GameSession, InputRecorder and
// KeyboardInput.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from '../core/session';
import { InputRecorder } from '../core/inputRecorder';
import { Game } from '../core/game';
import { Field } from '../core/field';
import { Wisp } from '../core/enemy';
import { KeyboardInput } from '../input/keyboard';
import { FxDirector } from './director';
import { HitStop } from './hitStop';
import { createDefaultFxParams } from './params';
import { applyImpactNotices, beginLiveTick, GameOverConfirmGate, FeedbackSource } from './liveTick';
import { ScoreRoll } from './scoreRoll';
import type { ClaimFeedback } from '../core/feedback';
import {
  FX_SCORE_ROLL_TICKS,
  FX_GAMEOVER_HOLD_TICKS,
  FX_HITSTOP_CLAIM_LARGE_TICKS,
  FX_HITSTOP_MISS_TICKS,
  FX_HITSTOP_SPLIT_TICKS,
  FX_SPLIT_BANNER_TICKS,
  FX_SPLIT_CONFIRM_LOCK_TICKS,
} from '../config';

type Carry = { score: number; lives: number; multiplier: number };
type Factory = (stage: number, carry: Carry) => Game;

/** 10x5 field; a straight line down x=7 claims 18 of 24 cells (75%): a large claim that clears the stage. */
const clearFactory: Factory = (_stage, carry) =>
  new Game(new Field(10, 5), { x: 7, y: 0 }, new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2), undefined, {
    ...carry,
    captureFeedback: true,
  });

/** 10x5 field with a pinned Wisp on each side of x=5: a line down x=5 splits them. */
const splitFactory: Factory = (_stage, carry) =>
  new Game(new Field(10, 5), { x: 5, y: 0 }, undefined, undefined, {
    ...carry,
    wisps: [new Wisp({ x: 2, y: 2 }, () => 0.5, Math.PI / 2), new Wisp({ x: 7, y: 2 }, () => 0.5, Math.PI / 2)],
    captureFeedback: true,
  });

/** 6x5 field with the Wisp right below the marker: stepping down is a miss. Starts on 1 life. */
const lastLifeFactory: Factory = (_stage, carry) =>
  new Game(new Field(6, 5), { x: 2, y: 0 }, new Wisp({ x: 2, y: 1 }, () => 0.5, 0), undefined, {
    ...carry,
    lives: 1,
    captureFeedback: true,
  });

function press(target: EventTarget, type: 'keydown' | 'keyup', code: string): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code });
  target.dispatchEvent(event);
}

/** A stand-in for main.ts's live loop around one GameSession. */
class LiveHarness {
  readonly keys = new EventTarget();
  readonly keyboard = new KeyboardInput(this.keys);
  readonly fx = new FxDirector(createDefaultFxParams());
  readonly hitStop = new HitStop();
  readonly gate = new GameOverConfirmGate();
  readonly recorder = new InputRecorder();
  readonly session: GameSession;
  /** Every input that reached session.update(). */
  readonly delivered: SessionInput[] = [];
  /** The HUD score count-up, ticked and fed the way main.ts does. */
  readonly roll = new ScoreRoll();
  readonly sounds: Array<{ kind: 'claim'; chain: number } | { kind: 'split' }> = [];
  modalShown = false;
  stoppedTicks = 0;

  constructor(gameFactory: Factory, timeLimitTicks?: number) {
    this.session = new GameSession({ gameFactory, captureFeedback: true, timeLimitTicks });
  }

  tick(): void {
    const status = this.session.getStatus();
    this.roll.tick();
    const input = beginLiveTick({
      fx: this.fx,
      hitStop: this.hitStop,
      gate: this.gate,
      status,
      readInput: () => this.keyboard.getInput(),
    });
    if (!input) {
      this.stoppedTicks++;
      return;
    }
    const stageBefore = this.session.getStage();
    this.delivered.push(input);
    this.session.update(input);
    if (status === 'gameover' && this.session.getStatus() === 'title') {
      this.recorder.reset();
      this.hitStop.clear();
      this.fx.reset();
    } else if (status === 'stageclear' && this.session.getStage() !== stageBefore) {
      this.hitStop.clear();
      this.fx.resetBoard();
    }
    this.recorder.observe(this.session, input);
    this.session.drainEvents();
    this.session.drainDespawnedEmberPositions();
    applyImpactNotices(this.session, this.fx, this.hitStop, {
      playClaim: ({ chain }) => this.sounds.push({ kind: 'claim', chain }),
      playSplitImpact: () => this.sounds.push({ kind: 'split' }),
    });
    this.roll.setTarget(this.session.getScore(), FX_SCORE_ROLL_TICKS);
  }

  ticks(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
  }

  /** main.ts's renderFrame() GAME OVER modal decision. */
  render(): void {
    if (this.session.getStatus() === 'gameover') {
      if (!this.modalShown && !this.fx.isGameOverHeld()) {
        this.modalShown = true;
        this.gate.markModalShown();
      }
    } else {
      this.gate.reset();
      this.modalShown = false;
    }
  }

  pressConfirm(): void {
    press(this.keys, 'keydown', 'Enter');
    press(this.keys, 'keyup', 'Enter');
  }

  hold(code: string): void {
    press(this.keys, 'keydown', code);
  }

  release(code: string): void {
    press(this.keys, 'keyup', code);
  }

  start(): void {
    this.pressConfirm();
    this.tick(); // Title -> Playing
    expect(this.session.getStatus()).toBe('playing');
  }

  confirmsDelivered(): number {
    return this.delivered.filter((i) => i.confirm).length;
  }
}

describe('hit stop on a live tick', () => {
  it('freezes the run: no tick, no recorded sample, no input read; a confirm pressed meanwhile arrives once, right after', () => {
    const h = new LiveHarness(clearFactory);
    h.start();
    h.hold('ArrowDown');
    h.hold('Space');
    h.ticks(4); // closes the line: a 75% claim -> large stop, stage clear
    h.release('ArrowDown');
    h.release('Space');
    expect(h.session.getStatus()).toBe('stageclear');
    expect(h.hitStop.getRemaining()).toBe(FX_HITSTOP_CLAIM_LARGE_TICKS);

    const ticksAtClaim = h.session.getTotalTicks();
    const samplesAtClaim = h.recorder.getSamples().length;
    const deliveredAtClaim = h.delivered.length;
    const confirmsAtClaim = h.confirmsDelivered();

    h.tick();
    h.pressConfirm(); // pressed mid-stop
    h.ticks(FX_HITSTOP_CLAIM_LARGE_TICKS - 1);
    expect(h.stoppedTicks).toBe(FX_HITSTOP_CLAIM_LARGE_TICKS);
    expect(h.session.getTotalTicks()).toBe(ticksAtClaim);
    expect(h.recorder.getSamples()).toHaveLength(samplesAtClaim);
    expect(h.delivered).toHaveLength(deliveredAtClaim);
    expect(h.session.getStatus()).toBe('stageclear');

    h.tick(); // first tick after the stop
    expect(h.confirmsDelivered()).toBe(confirmsAtClaim + 1);
    expect(h.delivered[h.delivered.length - 1].confirm).toBe(true);
    expect(h.session.getStage()).toBe(2);

    h.ticks(5);
    expect(h.confirmsDelivered()).toBe(confirmsAtClaim + 1);
    expect(h.session.getStage()).toBe(2);
  });

  it('resumes recording one sample per playing tick after the stop', () => {
    const h = new LiveHarness(clearFactory);
    h.start();
    h.hold('ArrowDown');
    h.hold('Space');
    h.tick();
    expect(h.recorder.getSamples()).toHaveLength(1);
    h.ticks(3);
    expect(h.recorder.getSamples()).toHaveLength(4);
    expect(h.session.getTotalTicks()).toBe(4);
  });
});

describe('HUD score count-up on a live tick', () => {
  it('the session has the real score from the claim tick; the HUD number reaches it 18 ticks later, through the stop', () => {
    const h = new LiveHarness(clearFactory);
    h.start();
    h.hold('ArrowDown');
    h.hold('Space');
    h.ticks(4); // the claim tick
    h.release('ArrowDown');
    h.release('Space');
    const score = h.session.getScore();
    expect(score).toBeGreaterThan(0);
    expect(h.hitStop.getRemaining()).toBe(FX_HITSTOP_CLAIM_LARGE_TICKS);
    expect(h.roll.value()).toBe(0);
    let previous = 0;
    for (let t = 1; t <= FX_SCORE_ROLL_TICKS; t++) {
      h.tick();
      expect(h.session.getScore()).toBe(score); // what the modal, high score and share read
      const shown = h.roll.value();
      expect(Number.isInteger(shown)).toBe(true);
      expect(shown).toBeGreaterThanOrEqual(previous);
      if (t < FX_SCORE_ROLL_TICKS) expect(shown).toBeLessThan(score);
      previous = shown;
    }
    expect(h.roll.value()).toBe(score);
  });
});

describe('claim sounds and the chain', () => {
  function notice(overrides: Partial<ClaimFeedback>): ClaimFeedback {
    return {
      claimedCells: 10,
      occupancyBefore: 0.1,
      occupancyAfter: 0.13,
      lineSpeed: 'fast',
      areaScore: 30,
      stageClearBonus: 0,
      multiplier: 1,
      split: false,
      stageCleared: false,
      closedLine: [{ x: 3, y: 1 }],
      ...overrides,
    };
  }

  it('passes the chain to the claim sound, and plays the split sound (no chain) for a split', () => {
    const queue: ClaimFeedback[][] = [[notice({}), notice({})], [notice({ split: true, stageCleared: true })]];
    const source: FeedbackSource = {
      drainClaimFeedback: () => queue.shift() ?? [],
      drainMissFeedback: () => [],
      getMultiplier: () => 2,
      getStatus: () => 'playing',
      getGameOverReason: () => null,
    };
    const fx = new FxDirector(createDefaultFxParams());
    const hitStop = new HitStop();
    const played: Array<{ kind: string; chain?: number; share?: number }> = [];
    const sounds = {
      playClaim: (c: { share: number; chain: number }) => played.push({ kind: 'claim', chain: c.chain, share: c.share }),
      playSplitImpact: () => played.push({ kind: 'split' }),
    };
    applyImpactNotices(source, fx, hitStop, sounds);
    fx.tick();
    applyImpactNotices(source, fx, hitStop, sounds);
    expect(played).toEqual([
      { kind: 'claim', chain: 1, share: expect.closeTo(0.03, 10) },
      { kind: 'claim', chain: 2, share: expect.closeTo(0.03, 10) },
      { kind: 'split' },
    ]);
  });

  it('a real run: the first claim of the run plays at chain 1', () => {
    const h = new LiveHarness(clearFactory);
    h.start();
    h.hold('ArrowDown');
    h.hold('Space');
    h.ticks(4);
    expect(h.sounds).toEqual([{ kind: 'claim', chain: 1 }]);
  });
});

describe('confirm lock after a split', () => {
  function splitThenConfirmAt(tickAfterSplit: number): LiveHarness {
    const h = new LiveHarness(splitFactory);
    h.start();
    h.hold('ArrowDown');
    h.hold('Space');
    h.ticks(4); // the split tick
    h.release('ArrowDown');
    h.release('Space');
    expect(h.session.getStatus()).toBe('stageclear');
    expect(h.hitStop.getRemaining()).toBe(FX_HITSTOP_SPLIT_TICKS);
    for (let k = 1; k <= 200; k++) {
      if (k === tickAfterSplit) h.pressConfirm();
      h.tick();
    }
    return h;
  }

  it('drops a confirm pressed in the 40 ticks after the split (also one held through the stop)', () => {
    for (const k of [1, 10, FX_HITSTOP_SPLIT_TICKS + 1, FX_SPLIT_CONFIRM_LOCK_TICKS - 1]) {
      const h = splitThenConfirmAt(k);
      expect(h.session.getStatus()).toBe('stageclear');
      expect(h.session.getStage()).toBe(1);
    }
  });

  it('passes a confirm from 40 ticks after the split on', () => {
    for (const k of [FX_SPLIT_CONFIRM_LOCK_TICKS, 50, 120]) {
      const h = splitThenConfirmAt(k);
      expect(h.session.getStage()).toBe(2);
      expect(h.session.getStatus()).toBe('playing');
    }
  });

  it('keeps SPLIT! up for 60 ticks in total when a confirm at 40-59 starts the next stage', () => {
    for (const k of [FX_SPLIT_CONFIRM_LOCK_TICKS, 45, FX_SPLIT_BANNER_TICKS - 1]) {
      const h = new LiveHarness(splitFactory);
      h.start();
      h.hold('ArrowDown');
      h.hold('Space');
      h.ticks(4);
      h.release('ArrowDown');
      h.release('Space');
      let bannerTicks = h.fx.isSplitBannerActive() ? 1 : 0;
      let advancedAt = -1;
      for (let t = 1; t <= 120; t++) {
        if (t === k) h.pressConfirm();
        h.tick();
        if (advancedAt < 0 && h.session.getStage() === 2) advancedAt = t;
        if (h.fx.isSplitBannerActive()) bannerTicks++;
      }
      expect(advancedAt).toBe(k);
      expect(bannerTicks).toBe(FX_SPLIT_BANNER_TICKS);
    }
  });
});

describe('GAME OVER after a game-ending miss', () => {
  function missOnLastLife(): LiveHarness {
    const h = new LiveHarness(lastLifeFactory);
    h.start();
    h.hold('ArrowDown');
    h.hold('Space');
    h.tick(); // steps onto the Wisp: the last life is lost
    h.release('ArrowDown');
    h.release('Space');
    expect(h.session.getStatus()).toBe('gameover');
    expect(h.session.getGameOverReason()).toBe('life');
    expect(h.hitStop.getRemaining()).toBe(FX_HITSTOP_MISS_TICKS);
    return h;
  }

  it('shows the modal on the first frame 32 ticks after the miss, not before', () => {
    const h = missOnLastLife();
    for (let t = 1; t < FX_GAMEOVER_HOLD_TICKS; t++) {
      h.tick();
      h.render();
      expect(h.modalShown).toBe(false);
    }
    h.tick(); // tick 32
    h.render();
    expect(h.modalShown).toBe(true);
  });

  it('never delivers a confirm during the 32 ticks, even pressed on every tick, and never skips the modal', () => {
    const h = missOnLastLife();
    const confirmsBefore = h.confirmsDelivered();
    for (let t = 1; t < FX_GAMEOVER_HOLD_TICKS; t++) {
      h.pressConfirm();
      h.tick();
      h.render();
    }
    expect(h.confirmsDelivered()).toBe(confirmsBefore);
    expect(h.session.getStatus()).toBe('gameover');
    // Dropped, not kept: once the modal is up nothing is pending.
    h.ticks(1);
    h.render();
    expect(h.modalShown).toBe(true);
    h.ticks(20);
    expect(h.session.getStatus()).toBe('gameover');
    expect(h.confirmsDelivered()).toBe(confirmsBefore);
  });

  it('keeps the confirm pressed on the tick the hold ends until the modal is drawn, then delivers it once', () => {
    const h = missOnLastLife();
    h.ticks(FX_GAMEOVER_HOLD_TICKS - 1);
    h.pressConfirm();
    h.tick(); // tick 32: the hold has just ended, the modal is not drawn yet
    expect(h.session.getStatus()).toBe('gameover');
    h.render();
    expect(h.modalShown).toBe(true);
    expect(h.session.getStatus()).toBe('gameover');
    h.tick(); // the first tick after the modal was drawn
    expect(h.session.getStatus()).toBe('title');
  });

  it('with many ticks per frame: confirm on every tick still cannot leave GAME OVER before the modal is drawn', () => {
    const h = missOnLastLife();
    for (let t = 1; t <= FX_GAMEOVER_HOLD_TICKS + 30; t++) {
      h.pressConfirm();
      h.tick();
      expect(h.session.getStatus()).toBe('gameover');
    }
    expect(h.modalShown).toBe(false);
    const confirmsBefore = h.confirmsDelivered();
    h.render();
    expect(h.modalShown).toBe(true);
    h.tick();
    expect(h.confirmsDelivered()).toBe(confirmsBefore + 1);
    expect(h.session.getStatus()).toBe('title');
  });

  it('delivers a confirm kept between the hold and the modal exactly once', () => {
    const h = missOnLastLife();
    h.ticks(FX_GAMEOVER_HOLD_TICKS);
    h.pressConfirm();
    h.tick();
    h.pressConfirm();
    h.tick(); // two presses before the frame: still one kept confirm
    h.render();
    const confirmsBefore = h.confirmsDelivered();
    h.ticks(5);
    expect(h.confirmsDelivered()).toBe(confirmsBefore + 1);
  });
});

describe('GAME OVER on TIME UP', () => {
  it('adds no hold, but still keeps a confirm until the modal is drawn and then delivers it once', () => {
    const h = new LiveHarness(clearFactory, 3);
    h.start();
    h.ticks(3); // a 3-tick time limit
    expect(h.session.getStatus()).toBe('gameover');
    expect(h.session.getGameOverReason()).toBe('time');
    expect(h.fx.isGameOverHeld()).toBe(false);
    expect(h.hitStop.getRemaining()).toBe(0);

    h.pressConfirm();
    h.ticks(10);
    expect(h.session.getStatus()).toBe('gameover');
    const confirmsBefore = h.confirmsDelivered();
    h.render();
    expect(h.modalShown).toBe(true);
    h.tick();
    expect(h.confirmsDelivered()).toBe(confirmsBefore + 1);
    expect(h.session.getStatus()).toBe('title');
  });

  it('shows the modal on the very next frame', () => {
    const h = new LiveHarness(clearFactory, 3);
    h.start();
    h.ticks(3); // a 3-tick time limit
    h.render();
    expect(h.modalShown).toBe(true);
  });
});
