// The miss reason on the canvas: never shown smaller than
// FX_MISS_REASON_MIN_DISPLAY_PX on screen, and always wholly on the field —
// above the contact, or below it near the top edge.
import { afterEach, describe, it, expect } from 'vitest';
import { drawMissReason, missReasonFontPx, MISS_REASON_FONT_PX } from './fxLayer';
import { CANVAS_WIDTH, CANVAS_HEIGHT, FX_MISS_REASON_MIN_DISPLAY_PX, GRID_WIDTH, GRID_HEIGHT, JA_TEXT_FONT_FAMILY, RENDER_SCALE } from '../config';
import { setLocale, t } from '../i18n';

afterEach(() => setLocale('en'));

interface Draw {
  op: 'fill' | 'stroke';
  text: string;
  font: string;
  fontPx: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  lineWidth: number;
  alpha: number;
}

/** A 2D context stand-in that records the text drawn: each letter is 0.8 em wide, centered vertically on y. */
function recordingContext(): { ctx: CanvasRenderingContext2D; draws: Draw[] } {
  const draws: Draw[] = [];
  const state = { font: '10px monospace', lineWidth: 1, globalAlpha: 1, textAlign: 'start', textBaseline: 'alphabetic' };
  const stack: Array<typeof state> = [];
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)![1]);
  const width = (text: string) => Array.from(text).length * px() * 0.8;
  const record = (op: Draw['op']) => (text: string, x: number, y: number) => {
    expect(state.textAlign).toBe('left');
    expect(state.textBaseline).toBe('middle');
    const fontPx = px();
    const pad = op === 'stroke' ? state.lineWidth / 2 : 0;
    draws.push({
      op,
      text,
      font: state.font,
      fontPx,
      left: x - pad,
      right: x + width(text) + pad,
      top: y - fontPx / 2 - pad,
      bottom: y + fontPx / 2 + pad,
      lineWidth: state.lineWidth,
      alpha: state.globalAlpha,
    });
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
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    measureText: (text: string) => ({ width: width(text) }),
    fillText: record('fill'),
    strokeText: record('stroke'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}

const CORNERS = [
  { x: 0, y: 0 },
  { x: GRID_WIDTH - 1, y: 0 },
  { x: 0, y: GRID_HEIGHT - 1 },
  { x: GRID_WIDTH - 1, y: GRID_HEIGHT - 1 },
];

describe('missReasonFontPx', () => {
  it('at display scale 0.6 is at least 13 / 0.6 canvas px', () => {
    expect(missReasonFontPx(FX_MISS_REASON_MIN_DISPLAY_PX / 0.6)).toBeGreaterThanOrEqual(13 / 0.6);
  });

  it('keeps its own size on a field shown at full size or larger', () => {
    for (const scale of [1, 1.6, 2.5]) expect(missReasonFontPx(FX_MISS_REASON_MIN_DISPLAY_PX / scale)).toBe(MISS_REASON_FONT_PX);
  });
});

describe('drawMissReason', () => {
  for (const locale of ['en', 'ja'] as const) {
    it(`(${locale}) draws the whole text inside the field at every corner, at least 13 / 0.6 canvas px tall`, () => {
      setLocale(locale);
      const minFontPx = FX_MISS_REASON_MIN_DISPLAY_PX / 0.6;
      for (const key of ['miss.wisp', 'miss.ember', 'miss.blaze', 'miss.igniter'] as const) {
        for (const anchor of CORNERS) {
          const { ctx, draws } = recordingContext();
          drawMissReason(ctx, { text: t(key), anchor, alpha: 1 }, minFontPx);
          expect(draws.map((d) => d.op)).toEqual(['stroke', 'fill']);
          for (const d of draws) {
            expect(d.text).toBe(t(key));
            expect(d.fontPx).toBeGreaterThanOrEqual(13 / 0.6);
            expect(d.left).toBeGreaterThanOrEqual(0);
            expect(d.right).toBeLessThanOrEqual(CANVAS_WIDTH);
            expect(d.top).toBeGreaterThanOrEqual(0);
            expect(d.bottom).toBeLessThanOrEqual(CANVAS_HEIGHT);
          }
        }
      }
    });
  }

  it('sits above the contact, and below it near the top edge', () => {
    const middle = { x: GRID_WIDTH / 2, y: GRID_HEIGHT / 2 };
    const contactY = (middle.y + 0.5) * RENDER_SCALE;
    const above = recordingContext();
    drawMissReason(above.ctx, { text: 'STOPPED TOO LONG', anchor: middle, alpha: 1 }, 0);
    expect(above.draws[1].bottom).toBeLessThan(contactY);

    const top = { x: GRID_WIDTH / 2, y: 1 };
    const below = recordingContext();
    drawMissReason(below.ctx, { text: 'STOPPED TOO LONG', anchor: top, alpha: 1 }, 0);
    expect(below.draws[1].top).toBeGreaterThan((top.y + 0.5) * RENDER_SCALE);
  });

  it('is centred on the contact when it is away from the sides', () => {
    const anchor = { x: GRID_WIDTH / 2, y: GRID_HEIGHT / 2 };
    const { ctx, draws } = recordingContext();
    drawMissReason(ctx, { text: 'EMBER HIT YOU', anchor, alpha: 1 }, 0);
    const fill = draws[1];
    expect((fill.left + fill.right) / 2).toBeCloseTo((anchor.x + 0.5) * RENDER_SCALE);
  });

  it('uses the effects face in English and the Japanese sentence font in Japanese, bold', () => {
    const anchor = { x: 80, y: 60 };
    const en = recordingContext();
    drawMissReason(en.ctx, { text: 'X', anchor, alpha: 1 }, 0);
    expect(en.draws[1].font).toMatch(/^700 .*Orbitron/);
    setLocale('ja');
    const ja = recordingContext();
    drawMissReason(ja.ctx, { text: 'X', anchor, alpha: 1 }, 0);
    expect(ja.draws[1].font).toBe(`700 ${MISS_REASON_FONT_PX}px ${JA_TEXT_FONT_FAMILY}`);
  });

  it('has a dark edge under the fill and fades with the frame', () => {
    const { ctx, draws } = recordingContext();
    drawMissReason(ctx, { text: 'X', anchor: { x: 80, y: 60 }, alpha: 0.25 }, 0);
    expect(draws[0].op).toBe('stroke');
    expect(draws[0].lineWidth).toBeGreaterThanOrEqual(3);
    expect(draws.every((d) => d.alpha === 0.25)).toBe(true);
  });
});
