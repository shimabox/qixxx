// The Wisp's drawn shape: every cell its trail can hit, how opaque each one
// is, and the trail's color. Pure functions — no DOM/Canvas.
//
// The collision check (src/core/collision.ts's checkCollision()) hits on
// each trail point and on every cell between two consecutive points, walked
// along a Bresenham line. A fast Wisp's points lie 2 or more cells apart, so
// drawing the points alone would leave cells that hit but are not seen.
// wispTrailCells() walks the same line by the same rule (the core's walk is
// not exported, and the core is left as it is), so what is drawn is exactly
// what hits — src/render/wispShape.test.ts checks the two agree.
import type { Point } from '../core/field';
import type { WispSurgeLevel } from '../core/wispSurge';
import {
  COLOR_WISP_HEAD,
  COLOR_WISP_HEAD_SURGE_1,
  COLOR_WISP_HEAD_SURGE_2,
  COLOR_WISP_TRAIL_FAST,
  WISP_TRAIL_ALPHA_FAR,
  WISP_TRAIL_ALPHA_NEAR,
  WISP_TRAIL_FAST_AT_MULTIPLIER,
  WISP_TRAIL_GLOW_ALPHA_RATIO,
} from '../config';

export interface WispTrailCell {
  x: number;
  y: number;
  /**
   * Where the cell lies along the trail: 0 at the head, i at trail point i,
   * and a fraction between two points for the cells walked between them.
   */
  at: number;
}

/**
 * Every cell the trail can hit — its points and the cells between each two
 * consecutive points — each once, at its place nearest the head, ordered
 * from the tail to the head (the order they are painted in).
 */
export function wispTrailCells(trail: ReadonlyArray<Readonly<Point>>): WispTrailCell[] {
  const nearest = new Map<number, WispTrailCell>();
  const add = (x: number, y: number, at: number): void => {
    // Grid coordinates are small non-negative integers: one number per cell.
    const key = x * 65536 + y;
    const known = nearest.get(key);
    if (!known || at < known.at) nearest.set(key, { x, y, at });
  };
  for (let i = 0; i < trail.length; i++) {
    add(trail[i].x, trail[i].y, i);
    if (i + 1 < trail.length) {
      const between = cellsBetween(trail[i], trail[i + 1]);
      between.forEach((cell, k) => add(cell.x, cell.y, i + (k + 1) / (between.length + 1)));
    }
  }
  return [...nearest.values()].sort((a, b) => b.at - a.at);
}

/** The cells the trail is filled on: all of wispTrailCells() but the head's own cell, which the head is drawn over. */
export function wispTrailFillCells(trail: ReadonlyArray<Readonly<Point>>): WispTrailCell[] {
  return wispTrailCells(trail).filter((cell) => cell.at > 0);
}

/**
 * The opacity of a trail cell `at` along a trail of `trailLength` points:
 * WISP_TRAIL_ALPHA_NEAR at the first point behind the head (and between it
 * and the head), fading linearly to WISP_TRAIL_ALPHA_FAR at the last point.
 */
export function wispTrailAlpha(at: number, trailLength: number): number {
  const t = trailLength > 2 ? Math.min(1, Math.max(0, (at - 1) / (trailLength - 2))) : 0;
  return WISP_TRAIL_ALPHA_NEAR + (WISP_TRAIL_ALPHA_FAR - WISP_TRAIL_ALPHA_NEAR) * t;
}

/** The glow's opacity around a trail cell of opacity `alpha`. */
export function wispTrailGlowAlpha(alpha: number): number {
  return alpha * WISP_TRAIL_GLOW_ALPHA_RATIO;
}

/**
 * The trail's color for a Wisp at `speedMultiplier`: COLOR_WISP_HEAD at x1 or
 * slower, COLOR_WISP_TRAIL_FAST from WISP_TRAIL_FAST_AT_MULTIPLIER up, mixed
 * linearly between.
 */
export function wispTrailColor(speedMultiplier: number): string {
  const span = WISP_TRAIL_FAST_AT_MULTIPLIER - 1;
  const t = span > 0 ? Math.min(1, Math.max(0, (speedMultiplier - 1) / span)) : 1;
  const from = hexToRgb(COLOR_WISP_HEAD);
  const to = hexToRgb(COLOR_WISP_TRAIL_FAST);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return rgbToHex(mix(from.r, to.r), mix(from.g, to.g), mix(from.b, to.b));
}

/**
 * The head's color at a surge level (core/wispSurge.ts): COLOR_WISP_HEAD on
 * level 0, COLOR_WISP_HEAD_SURGE_1 and _2 above it. The surge cue's rings
 * take the same color.
 */
export function wispHeadColor(level: WispSurgeLevel): string {
  return level === 2 ? COLOR_WISP_HEAD_SURGE_2 : level === 1 ? COLOR_WISP_HEAD_SURGE_1 : COLOR_WISP_HEAD;
}

// The cells strictly between `a` and `b` on the Bresenham line from `a` to
// `b` (endpoints excluded) — the same walk, step for step, as
// src/core/collision.ts's scanBetween(). None for identical or adjacent
// (diagonal included) points.
function cellsBetween(a: Readonly<Point>, b: Readonly<Point>): Point[] {
  const cells: Point[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    if (x === b.x && y === b.y) break;
    cells.push({ x, y });
  }
  return cells;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
