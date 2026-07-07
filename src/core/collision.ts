// Collision detection between an enemy's head/body trail and the
// in-progress line / marker. Pure logic — no DOM/Canvas dependencies.
// See docs/plan.md §3.4 / §3.5 / §7.1 for the specification this implements.
import { Field, Point, LINE, BORDER } from './field';

/**
 * Returns true if the polyline described by `trail` (an enemy's head cell
 * followed by its recent distinct-cell history — see Wisp.getTrail() /
 * getTrailRef()) touches an in-progress LINE cell, or passes through the
 * marker's current position.
 *
 * Consecutive trail points are NOT assumed to be grid-adjacent: the cells
 * between each pair are interpolated (Bresenham, inlined in `scanBetween`
 * below — no intermediate array or Point objects are allocated) so a
 * fast-moving or sparsely-recorded trail cannot tunnel through a line.
 *
 * A confirmed border (BORDER) cell is always safe: even if a checked cell's
 * coordinates match the marker's position there, no collision is reported
 * (docs/plan.md §3.4 / §7.1: "確定境界線上のマーカーには敵は無害").
 *
 * `trail` (and its elements) is only ever read, never mutated — callers may
 * safely pass a hot-path non-cloning reference such as Wisp.getTrailRef().
 */
export function checkCollision(field: Field, trail: ReadonlyArray<Readonly<Point>>, markerPosition: Point): boolean {
  for (let i = 0; i < trail.length; i++) {
    if (cellHits(field, trail[i].x, trail[i].y, markerPosition)) {
      return true;
    }
    if (i + 1 < trail.length && scanBetween(field, trail[i], trail[i + 1], markerPosition)) {
      return true;
    }
  }
  return false;
}

function cellHits(field: Field, x: number, y: number, markerPosition: Point): boolean {
  const state = field.getAt(x, y);
  if (state === LINE) {
    return true;
  }
  return x === markerPosition.x && y === markerPosition.y && state !== BORDER;
}

/**
 * Walks the grid cells strictly between `a` and `b` along a Bresenham line
 * (endpoints excluded — callers check those themselves), checking each for
 * a collision as it's visited rather than collecting them into an array
 * first. Same cell sequence and visiting order as the original array-
 * returning `cellsBetween` this replaced. A no-op (returns false
 * immediately) for identical or grid-adjacent (incl. diagonal) points.
 */
function scanBetween(field: Field, a: Readonly<Point>, b: Readonly<Point>, markerPosition: Point): boolean {
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    if (x === b.x && y === b.y) {
      break;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    if (x === b.x && y === b.y) {
      break;
    }
    if (cellHits(field, x, y, markerPosition)) {
      return true;
    }
  }

  return false;
}
