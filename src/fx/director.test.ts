import { describe, it, expect, vi, afterEach } from 'vitest';
import { FxDirector, FxFrame } from './director';
import { createDefaultFxParams, classifyClaimShare } from './params';
import type { ClaimFeedback, MissFeedback } from '../core/feedback';
import {
  FX_POPUP_TICKS,
  FX_SPLIT_BANNER_TICKS,
  FX_SPLIT_CONFIRM_LOCK_TICKS,
  FX_GAMEOVER_HOLD_TICKS,
  FX_MULTIPLIER_FLY_TICKS,
  FX_MULTIPLIER_HIGHLIGHT_TICKS,
  FX_SHARD_TICKS,
  FX_SHAKE_LARGE,
  FX_SHAKE_MEDIUM,
  FX_SHAKE_SMALL,
} from '../config';

function claim(share: number, overrides: Partial<ClaimFeedback> = {}): ClaimFeedback {
  return {
    claimedCells: 100,
    occupancyBefore: 0.1,
    occupancyAfter: 0.1 + share,
    lineSpeed: 'fast',
    areaScore: 50,
    bigClaim: false,
    nearMissBonus: 0,
    stageClearBonus: 0,
    multiplier: 1,
    split: false,
    stageCleared: false,
    closedLine: [
      { x: 10, y: 1 },
      { x: 10, y: 2 },
      { x: 10, y: 3 },
    ],
    ...overrides,
  };
}

function miss(overrides: Partial<MissFeedback> = {}): MissFeedback {
  return {
    cause: 'wisp',
    position: { x: 10, y: 5 },
    line: [
      { x: 10, y: 1 },
      { x: 10, y: 2 },
      { x: 10, y: 3 },
      { x: 10, y: 4 },
      { x: 10, y: 5 },
    ],
    ...overrides,
  };
}

/** `n` cells straight down from (20, 1), turning right halfway. */
function longLine(n: number): Array<{ x: number; y: number }> {
  const half = Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) => (i < half ? { x: 20, y: 1 + i } : { x: 21 + i - half, y: half }));
}

function ticks(fx: FxDirector, n: number): void {
  for (let i = 0; i < n; i++) fx.tick();
}

const NEXT = { nextMultiplier: 1 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FxDirector — hit stop lengths', () => {
  it('stops 3 / 6 / 10 ticks for a claim adding under 5%, 5% to under 20%, and 20% or more', () => {
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.onClaim(claim(0.0), NEXT).hitStopTicks).toBe(3);
    expect(fx.onClaim(claim(0.049), NEXT).hitStopTicks).toBe(3);
    expect(fx.onClaim(claim(0.05), NEXT).hitStopTicks).toBe(6);
    expect(fx.onClaim(claim(0.199), NEXT).hitStopTicks).toBe(6);
    expect(fx.onClaim(claim(0.2), NEXT).hitStopTicks).toBe(10);
    expect(fx.onClaim(claim(0.5), NEXT).hitStopTicks).toBe(10);
  });

  it('measures the size from occupancyAfter - occupancyBefore, not from the totals', () => {
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.onClaim(claim(0.01, { occupancyBefore: 0.6, occupancyAfter: 0.61 }), NEXT).hitStopTicks).toBe(3);
  });

  it('stops 20 ticks for a split, whatever its size', () => {
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.onClaim(claim(0.01, { split: true, stageCleared: true }), NEXT).hitStopTicks).toBe(20);
    expect(fx.onClaim(claim(0.3, { split: true, stageCleared: true }), NEXT).hitStopTicks).toBe(20);
  });

  it('stops 12 ticks for a miss', () => {
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.onMiss(miss(), { gameOver: false }).hitStopTicks).toBe(12);
    expect(fx.onMiss(miss({ line: [] }), { gameOver: true }).hitStopTicks).toBe(12);
  });

  it('reads the live params, so a changed value applies from the next effect', () => {
    const params = createDefaultFxParams();
    const fx = new FxDirector(params);
    params.hitStopClaimSmallTicks = 7;
    params.claimShareMid = 0.5;
    params.claimShareLarge = 0.9;
    expect(fx.onClaim(claim(0.3), NEXT).hitStopTicks).toBe(7);
    expect(classifyClaimShare(0.3, params)).toBe('small');
  });
});

describe('FxDirector — claim effects', () => {
  it('shows "+areaScore" for 40 ticks, then drops it', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { areaScore: 123 }), NEXT);
    expect(fx.getFrame().popups).toEqual([
      expect.objectContaining({ text: '+123', note: null, progress: 0, anchor: { x: 10, y: 2 } }),
    ]);
    ticks(fx, FX_POPUP_TICKS - 1);
    expect(fx.getFrame().popups).toHaveLength(1);
    fx.tick();
    expect(fx.getFrame().popups).toEqual([]);
  });

  it('adds x2 under the popup for a slow line, and shows nothing for a 0-point claim', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { lineSpeed: 'slow' }), NEXT);
    expect(fx.getFrame().popups[0].note).toBe('x2');
    fx.reset();
    fx.onClaim(claim(0.03, { areaScore: 0 }), NEXT);
    expect(fx.getFrame().popups).toEqual([]);
  });

  it('glows the closed line and reveals the fill, the reveal finishing within FX_FILL_REVEAL_TICKS', () => {
    const params = createDefaultFxParams();
    const fx = new FxDirector(params);
    fx.onClaim(claim(0.03), NEXT);
    const frame = fx.getFrame();
    expect(frame.lineGlows).toEqual([{ cells: claim(0).closedLine, intensity: 1, extendToEdges: false }]);
    expect(frame.fillReveal?.progress).toBeGreaterThan(0);
    expect(frame.fillReveal?.progress).toBeLessThan(1);
    ticks(fx, params.fillRevealTicks - 1);
    expect(fx.getFrame().fillReveal?.progress).toBe(1);
    fx.tick();
    expect(fx.getFrame().fillReveal).toBeNull();
    expect(fx.getFrame().lineGlows).toEqual([]);
  });

  it('gives each claim a new reveal id, and ties its popup to it', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    const first = fx.getFrame().fillReveal!.id;
    fx.tick();
    fx.onClaim(claim(0.03), NEXT);
    const frame = fx.getFrame();
    expect(frame.fillReveal!.id).not.toBe(first);
    expect(frame.fillReveal!.progress).toBeLessThan(1);
    expect(frame.popups.map((p) => p.revealId)).toEqual([first, frame.fillReveal!.id]);
  });

  it('shakes only for a large claim, small and vertical only', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.1), NEXT);
    expect(fx.getFrame().shake).toEqual({ x: 0, y: 0 });
    fx.onClaim(claim(0.25), NEXT);
    expect(fx.getFrame().shake).toEqual({ x: 0, y: FX_SHAKE_SMALL.amplitudePx });
  });

  it('a split: no popup, the split stop, a large shake, the extended flash, SPLIT! and the multiplier flight', () => {
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.onClaim(claim(0.03, { split: true, stageCleared: true }), { nextMultiplier: 2 }).hitStopTicks).toBe(20);
    const frame = fx.getFrame();
    expect(frame.popups).toEqual([]);
    expect(frame.shake).toEqual({ x: FX_SHAKE_LARGE.amplitudePx, y: -FX_SHAKE_LARGE.amplitudePx });
    expect(frame.lineGlows.map((g) => g.extendToEdges)).toEqual([false, true]);
    expect(frame.fillReveal).not.toBeNull();
    expect(frame.splitBanner).toEqual(expect.objectContaining({ progress: 0, age: 0 }));
    expect(frame.multiplierFly?.text).toBe('x2');
    expect(fx.isSplitBannerActive()).toBe(true);
  });
});

describe('FxDirector — split timing', () => {
  it('shows SPLIT! for 60 ticks and locks confirm for the first 40', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { split: true, stageCleared: true }), { nextMultiplier: 2 });
    let bannerTicks = 1; // the split tick itself
    let lockedTicks = 1;
    for (let t = 1; t < 200; t++) {
      fx.tick();
      if (fx.isSplitBannerActive()) bannerTicks++;
      if (fx.isConfirmLocked()) lockedTicks++;
    }
    expect(bannerTicks).toBe(FX_SPLIT_BANNER_TICKS);
    expect(lockedTicks).toBe(FX_SPLIT_CONFIRM_LOCK_TICKS);
    expect(fx.isGameOverHeld()).toBe(false);
  });

  it('keeps SPLIT! and the multiplier flight for the full time when the next stage starts at tick 40-59', () => {
    for (const advanceAt of [40, 45, 59]) {
      const fx = new FxDirector(createDefaultFxParams());
      fx.onClaim(claim(0.03, { split: true, stageCleared: true }), { nextMultiplier: 3 });
      let bannerTicks = 1;
      let flightOrHighlight = 1;
      for (let t = 1; t < 200; t++) {
        fx.tick();
        if (t === advanceAt) {
          expect(fx.isConfirmLocked()).toBe(false);
          fx.resetBoard(); // what main.ts does when the confirm starts the next stage
        }
        const frame = fx.getFrame();
        if (frame.splitBanner) bannerTicks++;
        if (frame.multiplierFly || frame.multiplierHighlight > 0) flightOrHighlight++;
      }
      expect(bannerTicks).toBe(FX_SPLIT_BANNER_TICKS);
      expect(flightOrHighlight).toBe(FX_MULTIPLIER_FLY_TICKS + FX_MULTIPLIER_HIGHLIGHT_TICKS);
    }
  });

  it('flies the multiplier for 40 ticks, then highlights the HUD for 20', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { split: true, stageCleared: true }), { nextMultiplier: 2 });
    expect(fx.isMultiplierFlying()).toBe(true);
    ticks(fx, FX_MULTIPLIER_FLY_TICKS - 1);
    expect(fx.getFrame().multiplierFly?.progress).toBe(1);
    expect(fx.isMultiplierFlying()).toBe(true);
    expect(fx.getFrame().multiplierHighlight).toBe(0);
    fx.tick();
    expect(fx.getFrame().multiplierFly).toBeNull();
    expect(fx.isMultiplierFlying()).toBe(false);
    expect(fx.getFrame().multiplierHighlight).toBe(1);
    ticks(fx, FX_MULTIPLIER_HIGHLIGHT_TICKS);
    expect(fx.getFrame().multiplierHighlight).toBe(0);
  });

  it('resetBoard() drops the board-bound effects but not the banner, the flight or the locks', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { split: true, stageCleared: true }), { nextMultiplier: 2 });
    fx.onMiss(miss(), { gameOver: false });
    fx.resetBoard();
    const frame = fx.getFrame();
    expect(frame.lineGlows).toEqual([]);
    expect(frame.fillReveal).toBeNull();
    expect(frame.popups).toEqual([]);
    expect(frame.shards).toEqual([]);
    expect(frame.flash).toEqual({ kind: 'none' });
    expect(frame.shake).toEqual({ x: 0, y: 0 });
    expect(frame.splitBanner).not.toBeNull();
    expect(frame.multiplierFly).not.toBeNull();
    expect(fx.isConfirmLocked()).toBe(true);
  });

  it('reset() drops everything', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { split: true, stageCleared: true }), { nextMultiplier: 2 });
    fx.onMiss(miss(), { gameOver: true });
    fx.reset();
    expect(fx.getFrame()).toEqual(new FxDirector(createDefaultFxParams()).getFrame());
    expect(fx.isConfirmLocked()).toBe(false);
    expect(fx.isGameOverHeld()).toBe(false);
    expect(fx.isSplitBannerActive()).toBe(false);
  });
});

describe('FxDirector — miss effects', () => {
  it('flashes light for 2 ticks then dark for 2 at the contact, with a medium shake', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false });
    const kinds: string[] = [];
    for (let t = 0; t < 6; t++) {
      const flash = fx.getFrame().flash;
      kinds.push(flash.kind);
      if (flash.kind !== 'none') expect(flash.center).toEqual({ x: 10, y: 5 });
      fx.tick();
    }
    expect(kinds).toEqual(['light', 'light', 'dark', 'dark', 'none', 'none']);
    const shakeFx = new FxDirector(createDefaultFxParams());
    shakeFx.onMiss(miss(), { gameOver: false });
    expect(shakeFx.getFrame().shake).toEqual({ x: FX_SHAKE_MEDIUM.amplitudePx, y: -FX_SHAKE_MEDIUM.amplitudePx });
  });

  it('breaks the line into shards from the contact toward the root, all gone after 20 ticks', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false }); // contact at the tip (10,5)
    expect(fx.getFrame().shards).toHaveLength(5);
    fx.tick();
    const early = fx.getFrame().shards;
    // The shard at the contact moves first; the root's has not started yet.
    expect(early[4].alpha).toBeLessThan(1);
    expect(early[0].alpha).toBe(1);
    // Shards drift across a vertical line, i.e. sideways.
    expect(early[4].offsetY).toBe(0);
    expect(Math.abs(early[4].offsetX)).toBeGreaterThan(0);
    ticks(fx, FX_SHARD_TICKS - 2);
    expect(fx.getFrame().shards).toHaveLength(5);
    fx.tick();
    expect(fx.getFrame().shards).toEqual([]);
  });

  it('makes no shards when no line was being drawn', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss({ cause: 'ember', line: [] }), { gameOver: false });
    expect(fx.getFrame().shards).toEqual([]);
  });

  it('holds the GAME OVER modal and confirm for 32 ticks after a game-ending miss only', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false });
    expect(fx.isGameOverHeld()).toBe(false);
    expect(fx.isConfirmLocked()).toBe(false);

    fx.onMiss(miss(), { gameOver: true });
    let held = 1; // the miss tick itself
    for (let t = 1; t < 100; t++) {
      fx.tick();
      if (fx.isGameOverHeld()) {
        held++;
        expect(fx.isConfirmLocked()).toBe(true);
      }
    }
    expect(held).toBe(FX_GAMEOVER_HOLD_TICKS);
    expect(fx.isConfirmLocked()).toBe(false);
  });
});

describe('FxDirector — reduced motion', () => {
  function everyFrame(fx: FxDirector, n: number): FxFrame[] {
    const frames: FxFrame[] = [];
    for (let i = 0; i < n; i++) {
      frames.push(fx.getFrame());
      fx.tick();
    }
    return frames;
  }

  it('never shakes or flashes, for any effect, but keeps the stop lengths, popups, shards and banner', () => {
    const normal = new FxDirector(createDefaultFxParams());
    const reduced = new FxDirector(createDefaultFxParams(), { reducedMotion: true });
    const stops: number[][] = [[], []];
    [normal, reduced].forEach((fx, i) => {
      stops[i].push(fx.onClaim(claim(0.03), NEXT).hitStopTicks);
      stops[i].push(fx.onClaim(claim(0.1), NEXT).hitStopTicks);
      stops[i].push(fx.onClaim(claim(0.3), NEXT).hitStopTicks);
      stops[i].push(fx.onClaim(claim(0.3, { split: true, stageCleared: true }), { nextMultiplier: 2 }).hitStopTicks);
      stops[i].push(fx.onMiss(miss(), { gameOver: true }).hitStopTicks);
    });
    expect(stops[1]).toEqual(stops[0]);

    const normalFrames = everyFrame(normal, 80);
    const reducedFrames = everyFrame(reduced, 80);
    expect(normalFrames.some((f) => f.shake.x !== 0 || f.shake.y !== 0)).toBe(true);
    expect(normalFrames.some((f) => f.flash.kind !== 'none')).toBe(true);
    for (const f of reducedFrames) {
      expect(f.shake).toEqual({ x: 0, y: 0 });
      expect(f.flash).toEqual({ kind: 'none' });
    }
    // Everything else is identical, except the text's tearing and colour
    // split, which reduced motion also turns off (tested below and in
    // directorFeel.test.ts).
    const strip = (f: FxFrame) => ({
      ...f,
      shake: null,
      flash: null,
      popups: f.popups.map((p) => ({ ...p, channelOffset: null })),
      splitBanner: f.splitBanner ? { ...f.splitBanner, glitch: null } : null,
      multiplierFly: f.multiplierFly ? { ...f.multiplierFly, channelOffset: null } : null,
    });
    expect(reducedFrames.map(strip)).toEqual(normalFrames.map(strip));
    expect(reducedFrames[0].popups.length).toBeGreaterThan(0);
    expect(reducedFrames[0].shards.length).toBeGreaterThan(0);
    expect(reducedFrames[0].splitBanner).not.toBeNull();
  });

  it('can be switched at run time', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onMiss(miss(), { gameOver: false });
    expect(fx.getFrame().flash.kind).toBe('light');
    fx.setReducedMotion(true);
    expect(fx.getFrame().flash.kind).toBe('none');
    expect(fx.getFrame().shake).toEqual({ x: 0, y: 0 });
    fx.setReducedMotion(false);
    expect(fx.getFrame().flash.kind).toBe('light');
  });
});

describe('FxDirector — determinism', () => {
  function script(fx: FxDirector): FxFrame[] {
    const frames: FxFrame[] = [];
    const record = (n: number) => {
      for (let i = 0; i < n; i++) {
        frames.push(fx.getFrame());
        fx.tick();
      }
    };
    fx.onClaim(claim(0.03, { lineSpeed: 'slow' }), NEXT);
    record(5);
    fx.onClaim(claim(0.25), NEXT);
    record(7);
    fx.onMiss(miss({ position: { x: 10, y: 3 } }), { gameOver: false });
    record(9);
    fx.onClaim(claim(0.08, { split: true, stageCleared: true }), { nextMultiplier: 4 });
    record(30);
    fx.onClaim(claim(0.35, { closedLine: longLine(60) }), NEXT);
    fx.onClaim(claim(0.22), NEXT);
    record(20);
    fx.resetBoard();
    record(40);
    fx.onMiss(miss(), { gameOver: true });
    record(40);
    return frames;
  }

  it('turns the same call sequence into the same frames, without Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const a = script(new FxDirector(createDefaultFxParams()));
    const b = script(new FxDirector(createDefaultFxParams()));
    expect(b).toEqual(a);
    expect(random).not.toHaveBeenCalled();
  });
});
