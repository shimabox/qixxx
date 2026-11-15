// The miss reason's timing in the director: shown from the miss for
// FX_MISS_REASON_TICKS director ticks (hit-stopped ticks included), fading over
// its last FX_MISS_REASON_FADE_TICKS, replaced by the next miss and dropped
// with the board.
import { describe, it, expect } from 'vitest';
import { FxDirector } from './director';
import { createDefaultFxParams } from './params';
import { HitStop } from './hitStop';
import { applyImpactNotices, beginLiveTick, GameOverConfirmGate } from './liveTick';
import type { MissFeedback } from '../core/feedback';
import type { SessionInput } from '../core/session';
import { FX_MISS_REASON_TICKS, FX_MISS_REASON_FADE_TICKS, FX_HITSTOP_MISS_TICKS } from '../config';

function miss(position = { x: 40, y: 30 }): MissFeedback {
  return { cause: 'igniter', position, line: [] };
}

const NO_INPUT: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };

describe('miss reason', () => {
  it('uses the configured length and fade', () => {
    expect(FX_MISS_REASON_TICKS).toBe(60);
    expect(FX_MISS_REASON_FADE_TICKS).toBe(12);
    expect(createDefaultFxParams().missReasonTicks).toBe(FX_MISS_REASON_TICKS);
  });

  it('is shown for 60 ticks from the miss — through the miss hit stop — then gone', () => {
    const fx = new FxDirector(createDefaultFxParams());
    const hitStop = new HitStop();
    const gate = new GameOverConfirmGate();
    hitStop.request(fx.onMiss(miss({ x: 12, y: 34 }), { gameOver: false, reason: 'STOPPED TOO LONG' }).hitStopTicks);
    expect(fx.getFrame().missReason).toEqual({ text: 'STOPPED TOO LONG', anchor: { x: 12, y: 34 }, alpha: 1 });

    // The live ticks the miss hit stop freezes: the reason stays up.
    let stopped = 0;
    let shown = 0;
    for (let tick = 0; tick < FX_MISS_REASON_TICKS - 1; tick++) {
      const polled = beginLiveTick({ fx, hitStop, gate, status: 'playing', readInput: () => NO_INPUT });
      if (polled === null) stopped++;
      if (fx.getFrame().missReason) shown++;
    }
    expect(stopped).toBe(FX_HITSTOP_MISS_TICKS);
    expect(shown).toBe(FX_MISS_REASON_TICKS - 1);
    fx.tick();
    expect(fx.getFrame().missReason).toBeNull();
  });

  it('is fully opaque until its last 12 ticks, then fades out', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false, reason: 'X' });
    const alphas: number[] = [];
    for (let tick = 0; tick < FX_MISS_REASON_TICKS; tick++) {
      alphas.push(fx.getFrame().missReason!.alpha);
      fx.tick();
    }
    const fadeFrom = FX_MISS_REASON_TICKS - FX_MISS_REASON_FADE_TICKS;
    expect(alphas.slice(0, fadeFrom).every((a) => a === 1)).toBe(true);
    const fading = alphas.slice(fadeFrom);
    for (let i = 1; i < fading.length; i++) expect(fading[i]).toBeLessThan(fading[i - 1]);
    expect(fading[0]).toBeLessThanOrEqual(1);
    expect(fading.at(-1)!).toBeGreaterThan(0);
  });

  it('is shown with reduced motion too', () => {
    const fx = new FxDirector(createDefaultFxParams(), { reducedMotion: true });
    fx.onMiss(miss(), { gameOver: false, reason: 'X' });
    expect(fx.getFrame().missReason?.text).toBe('X');
  });

  it('is shown for a game-ending miss as well', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: true, reason: 'X' });
    expect(fx.getFrame().missReason?.text).toBe('X');
  });

  it('is replaced by the next miss, which starts its own 60 ticks', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss({ x: 1, y: 1 }), { gameOver: false, reason: 'FIRST' });
    for (let i = 0; i < 30; i++) fx.tick();
    fx.onMiss(miss({ x: 2, y: 2 }), { gameOver: false, reason: 'SECOND' });
    expect(fx.getFrame().missReason).toEqual({ text: 'SECOND', anchor: { x: 2, y: 2 }, alpha: 1 });
    for (let i = 0; i < FX_MISS_REASON_TICKS - 1; i++) fx.tick();
    expect(fx.getFrame().missReason?.text).toBe('SECOND');
    fx.tick();
    expect(fx.getFrame().missReason).toBeNull();
  });

  it('is dropped when the stage changes and when a new run starts', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false, reason: 'X' });
    fx.resetBoard();
    expect(fx.getFrame().missReason).toBeNull();
    fx.onMiss(miss(), { gameOver: true, reason: 'X' });
    fx.reset();
    expect(fx.getFrame().missReason).toBeNull();
  });

  it("applyImpactNotices shows each miss's reason from the given lookup", () => {
    const fx = new FxDirector(createDefaultFxParams());
    const notice = miss({ x: 7, y: 8 });
    const session = {
      drainClaimFeedback: () => [],
      drainMissFeedback: () => [notice],
      getMultiplier: () => 1,
      getStatus: () => 'playing' as const,
      getGameOverReason: () => null,
    };
    const sounds = { playClaim: () => {}, playSplitImpact: () => {} };
    applyImpactNotices(session, fx, new HitStop(), sounds, (n) => (n === notice ? 'STOPPED TOO LONG' : null));
    expect(fx.getFrame().missReason).toEqual({ text: 'STOPPED TOO LONG', anchor: { x: 7, y: 8 }, alpha: 1 });
  });

  it('shows nothing for a miss without a reason', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false, reason: 'OLD' });
    fx.onMiss(miss(), { gameOver: false });
    expect(fx.getFrame().missReason).toBeNull();
  });
});
