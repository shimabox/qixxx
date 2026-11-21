// BIG CLAIM / CLOSE CALL on the canvas stay where they first appear for as
// long as they show — through their popup fading out and after it is gone,
// with reduced motion and without — and stay clear of their popup.
import { describe, it, expect } from 'vitest';
import { drawClaimTags, drawPopups, type FxTextBox } from './fxLayer';
import { FxDirector } from '../fx/director';
import { createDefaultFxParams } from '../fx/params';
import type { ClaimFeedback } from '../core/feedback';
import type { Point } from '../core/field';
import { FX_CLAIM_TAG_TICKS, FX_POPUP_TICKS } from '../config';

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A 2D context stand-in that records where text is drawn: each letter is 0.8 em wide, centered vertically on y. */
function recordingContext(): { ctx: CanvasRenderingContext2D; draws: Rect[] } {
  const draws: Rect[] = [];
  const state = { font: '10px monospace', lineWidth: 1, globalAlpha: 1, textAlign: 'start', textBaseline: 'alphabetic' };
  const stack: Array<typeof state> = [];
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)![1]);
  const width = (text: string) => Array.from(text).length * px() * 0.8;
  const record = (op: 'fill' | 'stroke') => (text: string, x: number, y: number) => {
    const fontPx = px();
    const pad = op === 'stroke' ? state.lineWidth / 2 : 0;
    draws.push({ left: x - pad, right: x + width(text) + pad, top: y - fontPx / 2 - pad, bottom: y + fontPx / 2 + pad });
  };
  const ctx = {
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: string) {
      state.textAlign = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: string) {
      state.textBaseline = v;
    },
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    globalCompositeOperation: 'source-over',
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    measureText: (text: string) => ({ width: width(text) }),
    fillText: record('fill'),
    strokeText: record('stroke'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}

function claim(at: Point, overrides: Partial<ClaimFeedback> = {}): ClaimFeedback {
  return {
    claimedCells: 4000,
    occupancyBefore: 0,
    occupancyAfter: 0.2,
    lineSpeed: 'slow',
    areaScore: 3000,
    bigClaim: true,
    nearMissBonus: 200,
    stageClearBonus: 0,
    multiplier: 1,
    split: false,
    splitMultiplierGain: 0,
    stageCleared: false,
    closedLine: [at, { x: at.x, y: at.y + 1 }],
    ...overrides,
  };
}

interface Tick {
  age: number;
  box: FxTextBox;
  popupShown: boolean;
  popupDraws: Rect[];
}

/** Every tick of one claim's tags, from the claim on: the box drawn, and the popup's text drawn on the same tick. */
function run(feedback: ClaimFeedback, reducedMotion: boolean, chained = false): Tick[] {
  const fx = new FxDirector(createDefaultFxParams(), { reducedMotion });
  // A claim just before makes this one's popup show CHAIN x2 as well (its tallest).
  if (chained) fx.onClaim(claim({ x: 80, y: 60 }, { bigClaim: false, nearMissBonus: 0 }), { nextMultiplier: 1 });
  fx.onClaim(feedback, { nextMultiplier: 2 });
  const at = (item: { anchor: Point }) => item.anchor;
  const ticks: Tick[] = [];
  for (;;) {
    const frame = fx.getFrame();
    const group = frame.claimTags.at(-1);
    if (!group) break;
    const popups = frame.popups.filter((p) => p.revealId === group.revealId);
    const popupCtx = recordingContext();
    drawPopups(popupCtx.ctx, popups, at);
    const boxes = drawClaimTags(recordingContext().ctx, [group], at);
    expect(boxes, `age ${group.age}`).toHaveLength(1);
    ticks.push({ age: group.age, box: boxes[0], popupShown: popups.length > 0, popupDraws: popupCtx.draws });
    fx.tick();
  }
  return ticks;
}

const center = (b: FxTextBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const overlaps = (a: Rect, b: FxTextBox) => a.left < b.x + b.width && b.x < a.right && a.top < b.y + b.height && b.y < a.bottom;

const CASES: Array<[string, ClaimFeedback, boolean]> = [
  ['in the middle', claim({ x: 80, y: 60 }), false],
  ['chained, in the middle', claim({ x: 80, y: 60 }), true],
  ['at the bottom edge (above its popup)', claim({ x: 3, y: 117 }), false],
  ['at the top edge', claim({ x: 157, y: 1 }), false],
  ['a split (under SPLIT!)', claim({ x: 80, y: 60 }, { split: true, stageCleared: true, splitMultiplierGain: 1 }), false],
];

describe('BIG CLAIM / CLOSE CALL', () => {
  it('outlast the popup', () => {
    expect(FX_CLAIM_TAG_TICKS).toBeGreaterThan(FX_POPUP_TICKS);
  });

  for (const [name, feedback, chained] of CASES) {
    it(`${name}: with reduced motion, the same box from the claim until they go`, () => {
      const ticks = run(feedback, true, chained);
      expect(ticks.map((t) => t.age)).toEqual(Array.from({ length: FX_CLAIM_TAG_TICKS }, (_, i) => i));
      if (!feedback.split) {
        // The popup goes partway through.
        expect(ticks[FX_POPUP_TICKS - 1].popupShown).toBe(true);
        expect(ticks[FX_POPUP_TICKS].popupShown).toBe(false);
      }
      for (const t of ticks) expect(t.box, `age ${t.age}`).toEqual(ticks[0].box);
    });

    it(`${name}: popping in, the same middle throughout and the same box once settled`, () => {
      const ticks = run(feedback, false, chained);
      expect(ticks).toHaveLength(FX_CLAIM_TAG_TICKS);
      const last = ticks.at(-1)!;
      for (const t of ticks) {
        expect(center(t.box).x, `age ${t.age}`).toBeCloseTo(center(last.box).x, 6);
        expect(center(t.box).y, `age ${t.age}`).toBeCloseTo(center(last.box).y, 6);
      }
      const settled = ticks.filter((t) => t.box.height === last.box.height);
      expect(settled.length).toBeGreaterThan(FX_CLAIM_TAG_TICKS - 10);
      for (const t of settled) expect(t.box, `age ${t.age}`).toEqual(last.box);
    });

    it(`${name}: never over its popup`, () => {
      for (const reduced of [true, false]) {
        for (const t of run(feedback, reduced, chained)) {
          for (const d of t.popupDraws) expect(overlaps(d, t.box), `age ${t.age} reduced ${reduced}`).toBe(false);
        }
      }
    });
  }
});
