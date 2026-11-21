// FxDirector: the praise word, the popup's bounce and colour split, the
// SPLIT! glitch, the chain of claims in a row and the sparks.
import { describe, it, expect } from 'vitest';
import { FxDirector } from './director';
import { createDefaultFxParams, praiseForClaimShare } from './params';
import type { ClaimFeedback, MissFeedback } from '../core/feedback';
import { FX_POPUP_TICKS } from '../config';

type Cell = { x: number; y: number };

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

function miss(): MissFeedback {
  return { cause: 'wisp', position: { x: 10, y: 3 }, line: [{ x: 10, y: 1 }, { x: 10, y: 2 }, { x: 10, y: 3 }] };
}

const SPLIT: Partial<ClaimFeedback> = { split: true, stageCleared: true };
const NEXT = { nextMultiplier: 1 };

/** `n` cells straight down from (20, 1), turning right halfway. */
function longLine(n: number): Cell[] {
  const half = Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) => (i < half ? { x: 20, y: 1 + i } : { x: 21 + i - half, y: half }));
}

function ticks(fx: FxDirector, n: number): void {
  for (let i = 0; i < n; i++) fx.tick();
}

describe('praise words', () => {
  it('NICE! from 5%, GREAT! from 20%, AWESOME! from 30% of added occupancy; nothing below 5%', () => {
    const cases: Array<[number, string | null]> = [
      [0, null],
      [0.049, null],
      [0.05, 'NICE!'],
      [0.199, 'NICE!'],
      [0.2, 'GREAT!'],
      [0.299, 'GREAT!'],
      [0.3, 'AWESOME!'],
      [0.8, 'AWESOME!'],
    ];
    for (const [share, praise] of cases) {
      const fx = new FxDirector(createDefaultFxParams());
      fx.onClaim(claim(share), NEXT);
      expect(fx.getFrame().popups[0].praise).toBe(praise);
      expect(praiseForClaimShare(share, createDefaultFxParams())).toBe(praise);
    }
  });

  it('measures the added occupancy (after - before), not the total', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.01, { occupancyBefore: 0.7, occupancyAfter: 0.71 }), NEXT);
    expect(fx.getFrame().popups[0].praise).toBeNull();
  });

  it('is not shown for a split (SPLIT! is)', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.5, SPLIT), { nextMultiplier: 2 });
    expect(fx.getFrame().popups).toEqual([]);
    expect(fx.getFrame().splitBanner).not.toBeNull();
  });

  it('lasts as long as the score popup', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.25), NEXT);
    ticks(fx, FX_POPUP_TICKS - 1);
    expect(fx.getFrame().popups[0].praise).toBe('GREAT!');
    fx.tick();
    expect(fx.getFrame().popups).toEqual([]);
  });

  it('follows the live threshold', () => {
    const params = createDefaultFxParams();
    params.claimShareHuge = 0.25;
    const fx = new FxDirector(params);
    fx.onClaim(claim(0.26), NEXT);
    expect(fx.getFrame().popups[0].praise).toBe('AWESOME!');
  });
});

describe('text motion in the frame', () => {
  it('the popup bounces in at 1.4x on ticks 0-2, is back to 1.0 on tick 7, and splits its colours on ticks 0-5 only', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    const seen: Array<{ age: number; scale: number; channelOffset: number }> = [];
    for (let i = 0; i < 12; i++) {
      const { age, scale, channelOffset } = fx.getFrame().popups[0];
      seen.push({ age, scale, channelOffset });
      fx.tick();
    }
    expect(seen.map((s) => s.age)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(seen.slice(0, 3).map((s) => s.scale)).toEqual([1.4, 1.4, 1.4]);
    for (let i = 3; i < 8; i++) expect(seen[i].scale).toBeLessThan(seen[i - 1].scale);
    expect(seen[7].scale).toBeCloseTo(1, 10);
    expect(seen.slice(8).every((s) => s.scale === 1)).toBe(true);
    expect(seen.slice(0, 6).every((s) => s.channelOffset > 0)).toBe(true);
    expect(seen.slice(6).every((s) => s.channelOffset === 0)).toBe(true);
  });

  it('SPLIT! is torn on its first 9 ticks; the travelling multiplier splits its colours for 6', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, SPLIT), { nextMultiplier: 2 });
    for (let tick = 0; tick < 12; tick++) {
      const frame = fx.getFrame();
      expect(frame.splitBanner?.age).toBe(tick);
      expect(frame.splitBanner?.glitch.bands).toHaveLength(tick < 9 ? 3 : 1);
      expect(frame.multiplierFly?.age).toBe(tick);
      expect((frame.multiplierFly?.channelOffset ?? 0) > 0).toBe(tick < 6);
      fx.tick();
    }
  });

  it('with reduced motion: no tearing and no colour split, but the bounce stays', () => {
    const fx = new FxDirector(createDefaultFxParams(), { reducedMotion: true });
    fx.onClaim(claim(0.03), NEXT);
    fx.onClaim(claim(0.03, SPLIT), { nextMultiplier: 2 });
    expect(fx.getFrame().popups[0].scale).toBe(1.4);
    for (let tick = 0; tick < 10; tick++) {
      const frame = fx.getFrame();
      expect(frame.splitBanner?.glitch).toEqual({ bands: [{ from: -1, to: 1, dx: 0 }], channelOffset: 0, alpha: 1 });
      expect(frame.multiplierFly?.channelOffset).toBe(0);
      expect(frame.popups[0].channelOffset).toBe(0);
      fx.tick();
    }
  });
});

describe('chain', () => {
  it('adds one for a claim within 180 ticks of the previous one, and starts again at 1 after more', () => {
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(1);
    ticks(fx, 180);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(2);
    ticks(fx, 10);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(3);
    expect(fx.getChain()).toBe(3);
    ticks(fx, 181);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(1);
  });

  it('shows CHAIN xN under the popup from the second claim in a row only', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    expect(fx.getFrame().popups[0].chain).toBeNull();
    fx.tick();
    fx.onClaim(claim(0.03), NEXT);
    expect(fx.getFrame().popups.map((p) => p.chain)).toEqual([null, 'CHAIN x2']);
  });

  it('goes back to 0 at a miss, at the next stage (resetBoard) and at reset()', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    fx.onClaim(claim(0.03), NEXT);
    fx.onMiss(miss(), { gameOver: false });
    expect(fx.getChain()).toBe(0);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(1);
    fx.onClaim(claim(0.03), NEXT);
    fx.resetBoard();
    expect(fx.getChain()).toBe(0);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(1);
    fx.onClaim(claim(0.03), NEXT);
    fx.reset();
    expect(fx.getChain()).toBe(0);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(1);
  });

  it('counts the ticks a hit stop freezes too (every tick() call)', () => {
    const fx = new FxDirector(createDefaultFxParams());
    const { hitStopTicks } = fx.onClaim(claim(0.25), NEXT);
    ticks(fx, hitStopTicks + 170); // 180 in all
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(2);
  });

  it('counts a split as a claim in the row', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    expect(fx.onClaim(claim(0.03, SPLIT), { nextMultiplier: 2 }).chain).toBe(2);
  });

  it('follows the live window', () => {
    const params = createDefaultFxParams();
    params.chainWindowTicks = 10;
    const fx = new FxDirector(params);
    fx.onClaim(claim(0.03), NEXT);
    ticks(fx, 11);
    expect(fx.onClaim(claim(0.03), NEXT).chain).toBe(1);
  });

  it('changes nothing but the chain: the stop and the popup are the same at any chain', () => {
    const lone = new FxDirector(createDefaultFxParams());
    const chained = new FxDirector(createDefaultFxParams());
    for (let i = 0; i < 5; i++) chained.onClaim(claim(0.03), NEXT);
    const a = lone.onClaim(claim(0.25, { areaScore: 999 }), NEXT);
    const b = chained.onClaim(claim(0.25, { areaScore: 999 }), NEXT);
    expect(b.chain).toBe(6);
    expect(b.hitStopTicks).toBe(a.hitStopTicks);
    const popA = lone.getFrame().popups.at(-1)!;
    const popB = chained.getFrame().popups.at(-1)!;
    expect(popB.chain).toBe('CHAIN x6');
    expect({ ...popB, chain: null, revealId: 0 }).toEqual({ ...popA, chain: null, revealId: 0 });
  });
});

describe('sparks', () => {
  it('one from each cell of a short line, at most 24 from a long one, also on a split', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    expect(fx.getFrame().sparks).toHaveLength(3);
    fx.reset();
    fx.onClaim(claim(0.03, { closedLine: longLine(200) }), NEXT);
    expect(fx.getFrame().sparks).toHaveLength(24);
    fx.reset();
    fx.onClaim(claim(0.03, { ...SPLIT, closedLine: longLine(30) }), { nextMultiplier: 2 });
    expect(fx.getFrame().sparks).toHaveLength(24);
  });

  it('picks cells at even steps along the line and sends them across it, alternating sides', () => {
    const fx = new FxDirector(createDefaultFxParams());
    const line = Array.from({ length: 48 }, (_, i) => ({ x: 30, y: 1 + i }));
    fx.onClaim(claim(0.03, { closedLine: line }), NEXT);
    fx.tick();
    const sparks = fx.getFrame().sparks;
    expect(sparks).toHaveLength(24);
    sparks.forEach((s, k) => {
      expect(s.y).toBe(1 + 2 * k + 1 + 0.5); // cells 1, 3, 5, ... of the line
      expect(Math.sign(s.x - 30.5)).toBe(k % 2 === 0 ? -1 : 1);
    });
  });

  it('flies 5 cells in 16 ticks, shrinking from one cell and fading, then is gone', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03, { closedLine: [{ x: 10, y: 10 }, { x: 10, y: 11 }] }), NEXT);
    const start = fx.getFrame().sparks[0];
    expect(start).toEqual({ x: 10.5, y: 10.5, size: 1, alpha: 1, progress: 0 });
    let last = start;
    for (let i = 1; i < 16; i++) {
      fx.tick();
      const s = fx.getFrame().sparks[0];
      expect(Math.abs(s.x - 10.5)).toBeGreaterThan(Math.abs(last.x - 10.5));
      expect(s.size).toBeLessThan(last.size);
      expect(s.alpha).toBeLessThan(last.alpha);
      expect(s.progress).toBeGreaterThan(last.progress);
      last = s;
    }
    expect(Math.abs(last.x - 10.5)).toBeGreaterThan(4.9);
    expect(Math.abs(last.x - 10.5)).toBeLessThanOrEqual(5);
    fx.tick();
    expect(fx.getFrame().sparks).toEqual([]);
  });

  it('the same line always sends the same sparks', () => {
    const line = longLine(77);
    const run = () => {
      const fx = new FxDirector(createDefaultFxParams());
      fx.onClaim(claim(0.03, { closedLine: line }), NEXT);
      const frames = [];
      for (let i = 0; i < 16; i++) {
        frames.push(fx.getFrame().sparks);
        fx.tick();
      }
      return frames;
    };
    expect(run()).toEqual(run());
  });

  it('follows the live params', () => {
    const params = createDefaultFxParams();
    params.sparkMax = 5;
    params.sparkTicks = 4;
    const fx = new FxDirector(params);
    fx.onClaim(claim(0.03, { closedLine: longLine(50) }), NEXT);
    expect(fx.getFrame().sparks).toHaveLength(5);
    ticks(fx, 3);
    expect(fx.getFrame().sparks).toHaveLength(5);
    fx.tick();
    expect(fx.getFrame().sparks).toEqual([]);
  });

  it('are dropped with the board', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(0.03), NEXT);
    fx.resetBoard();
    expect(fx.getFrame().sparks).toEqual([]);
  });
});
