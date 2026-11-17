import { describe, expect, it } from 'vitest';
import { checkCollision } from '../core/collision';
import { Wisp } from '../core/enemy';
import { Field, LINE, Point } from '../core/field';
import {
  COLOR_WISP_HEAD,
  COLOR_WISP_TRAIL_FAST,
  WISP_TRAIL_ALPHA_FAR,
  WISP_TRAIL_ALPHA_NEAR,
  WISP_TRAIL_FAST_AT_MULTIPLIER,
  WISP_TRAIL_GLOW_ALPHA_RATIO,
  WISP_TRAIL_GLOW_CELLS,
  WISP_HEAD_CORE_RADIUS_CELLS,
  WISP_HEAD_HALO_RADIUS_CELLS,
} from '../config';
import { wispTrailAlpha, wispTrailCells, wispTrailColor, wispTrailFillCells, wispTrailGlowAlpha } from './wispShape';

const SIZE = 40;
// The marker sits on the border, where the Wisp is harmless: only LINE cells count.
const MARKER_ON_BORDER: Point = { x: 0, y: 0 };

/** Every cell that, holding the only LINE cell on the field, makes checkCollision() report a hit. */
function hittableCells(trail: readonly Point[]): Set<string> {
  const hits = new Set<string>();
  const field = new Field(SIZE, SIZE);
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      field.set({ x, y }, LINE);
      if (checkCollision(field, trail, MARKER_ON_BORDER)) hits.add(`${x},${y}`);
      field.set({ x, y }, 0);
    }
  }
  return hits;
}

function keys(cells: readonly Point[]): Set<string> {
  return new Set(cells.map((c) => `${c.x},${c.y}`));
}

const TRAILS: Record<string, Point[]> = {
  'one point': [{ x: 20, y: 20 }],
  'adjacent points': [
    { x: 20, y: 20 },
    { x: 19, y: 20 },
    { x: 18, y: 20 },
    { x: 18, y: 21 },
  ],
  'diagonal neighbours': [
    { x: 20, y: 20 },
    { x: 19, y: 19 },
    { x: 18, y: 18 },
  ],
  '2 cells apart': [
    { x: 20, y: 20 },
    { x: 18, y: 20 },
    { x: 16, y: 20 },
  ],
  '3 to 5 cells apart, every direction': [
    { x: 20, y: 20 },
    { x: 23, y: 20 },
    { x: 23, y: 24 },
    { x: 18, y: 24 },
    { x: 18, y: 19 },
  ],
  'slanted steps': [
    { x: 20, y: 20 },
    { x: 22, y: 21 },
    { x: 25, y: 23 },
    { x: 26, y: 27 },
    { x: 21, y: 30 },
  ],
  'a bend back on itself': [
    { x: 20, y: 20 },
    { x: 22, y: 22 },
    { x: 24, y: 20 },
    { x: 22, y: 18 },
    { x: 20, y: 20 },
    { x: 17, y: 21 },
  ],
};

describe('wispTrailCells', () => {
  for (const [name, trail] of Object.entries(TRAILS)) {
    it(`covers exactly the cells the trail can hit: ${name}`, () => {
      const cells = wispTrailCells(trail);
      expect(keys(cells)).toEqual(hittableCells(trail));
      // Each cell once.
      expect(cells.length).toBe(keys(cells).size);
    });
  }

  it('covers exactly the hittable cells of many generated trails', () => {
    // A fixed linear congruential sequence: the same trails on every run.
    let state = 12345;
    const next = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let run = 0; run < 40; run++) {
      const trail: Point[] = [{ x: 20, y: 20 }];
      for (let i = 1; i < 10; i++) {
        const prev = trail[i - 1];
        trail.push({
          x: Math.min(SIZE - 3, Math.max(2, prev.x + next(7) - 3)),
          y: Math.min(SIZE - 3, Math.max(2, prev.y + next(7) - 3)),
        });
      }
      expect(keys(wispTrailCells(trail)), JSON.stringify(trail)).toEqual(hittableCells(trail));
    }
  });

  it('orders the cells from the tail to the head, each at its place along the trail', () => {
    const trail = [
      { x: 20, y: 20 },
      { x: 23, y: 20 },
      { x: 23, y: 22 },
    ];
    const cells = wispTrailCells(trail);
    expect(cells.map((c) => [c.x, c.y, c.at])).toEqual([
      [23, 22, 2],
      [23, 21, 1.5],
      [23, 20, 1],
      [22, 20, 2 / 3],
      [21, 20, 1 / 3],
      [20, 20, 0],
    ]);
  });

  it('leaves the head cell out of the cells filled (the head is drawn over it)', () => {
    const trail = TRAILS['slanted steps'];
    const fill = wispTrailFillCells(trail);
    expect(fill.some((c) => c.x === 20 && c.y === 20)).toBe(false);
    expect(new Set([...keys(fill), '20,20'])).toEqual(hittableCells(trail));
  });

  it('fills the cells between the trail points of a Wisp at speed x5', () => {
    const field = new Field(SIZE * 2, SIZE * 2);
    let state = 7;
    const rng = () => {
      state = (state * 16807) % 2147483647;
      return state / 2147483647;
    };
    const wisp = new Wisp({ x: SIZE, y: SIZE }, rng, 0.3, WISP_TRAIL_FAST_AT_MULTIPLIER);
    for (let i = 0; i < 40; i++) wisp.update(field);
    const trail = wisp.getTrail();
    expect(trail.length).toBe(10);
    // Fast enough that its trail points are 2 or more cells apart.
    const gaps = trail.slice(1).map((p, i) => Math.max(Math.abs(p.x - trail[i].x), Math.abs(p.y - trail[i].y)));
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(2);
    const fill = keys(wispTrailFillCells(trail));
    const points = keys(trail);
    const between = [...fill].filter((k) => !points.has(k));
    expect(between.length).toBeGreaterThan(0);
    // Every cell the Wisp can hit is drawn: its trail points, the cells
    // between them, and the head.
    const hittable = new Set<string>();
    const big = new Field(SIZE * 2, SIZE * 2);
    for (let y = 1; y < SIZE * 2 - 1; y++) {
      for (let x = 1; x < SIZE * 2 - 1; x++) {
        big.set({ x, y }, LINE);
        if (checkCollision(big, trail, MARKER_ON_BORDER)) hittable.add(`${x},${y}`);
        big.set({ x, y }, 0);
      }
    }
    expect(new Set([...fill, `${trail[0].x},${trail[0].y}`])).toEqual(hittable);
  });
});

describe('wispTrailAlpha', () => {
  it('runs from WISP_TRAIL_ALPHA_NEAR behind the head to WISP_TRAIL_ALPHA_FAR at the tail', () => {
    expect(WISP_TRAIL_ALPHA_NEAR).toBe(0.8);
    expect(WISP_TRAIL_ALPHA_FAR).toBe(0.35);
    expect(wispTrailAlpha(1, 10)).toBeCloseTo(0.8);
    expect(wispTrailAlpha(9, 10)).toBeCloseTo(0.35);
    // Between the head and the first trail point: as near as it gets.
    expect(wispTrailAlpha(0.5, 10)).toBeCloseTo(0.8);
    // A cell between two points: between their two values.
    const between = wispTrailAlpha(4.5, 10);
    expect(between).toBeLessThan(wispTrailAlpha(4, 10));
    expect(between).toBeGreaterThan(wispTrailAlpha(5, 10));
    expect(between).toBeCloseTo((wispTrailAlpha(4, 10) + wispTrailAlpha(5, 10)) / 2);
    // A two-point trail is all near.
    expect(wispTrailAlpha(1, 2)).toBeCloseTo(0.8);
  });

  it('gives the glow WISP_TRAIL_GLOW_ALPHA_RATIO of the fill, half a cell wide', () => {
    expect(WISP_TRAIL_GLOW_CELLS).toBe(0.5);
    expect(WISP_TRAIL_GLOW_ALPHA_RATIO).toBe(0.35);
    expect(wispTrailGlowAlpha(0.8)).toBeCloseTo(0.28);
  });
});

describe('wispTrailColor', () => {
  it('is purple at x1, a whitish pink from x5 up and halfway between at x3', () => {
    expect(wispTrailColor(1)).toBe('#b967ff');
    expect(wispTrailColor(0.5)).toBe('#b967ff');
    expect(wispTrailColor(5)).toBe(COLOR_WISP_TRAIL_FAST);
    expect(COLOR_WISP_TRAIL_FAST).toBe('#ffd6f5');
    expect(wispTrailColor(8)).toBe('#ffd6f5');
    // (0xb9 + 0xff) / 2 = 0xdc, (0x67 + 0xd6) / 2 ≈ 0x9f, (0xff + 0xf5) / 2 = 0xfa
    expect(wispTrailColor(3)).toBe('#dc9ffa');
  });

  it('leaves the head its own color, with the larger head', () => {
    expect(COLOR_WISP_HEAD).toBe('#b967ff');
    expect(WISP_HEAD_CORE_RADIUS_CELLS).toBe(1.1);
    expect(WISP_HEAD_HALO_RADIUS_CELLS).toBe(2.0);
  });
});
