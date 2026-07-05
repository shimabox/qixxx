// Collision detection between an enemy's head/body trail and the
// in-progress line / marker. Pure logic — no DOM/Canvas dependencies.
// See docs/plan.md §3.4 / §3.5 / §7.1 for the specification this implements.
import { Field, Point, LINE, BORDER } from './field';

/**
 * Returns true if the polyline described by `trail` (an enemy's head cell
 * followed by its recent distinct-cell history — see Wisp.getTrail())
 * touches an in-progress LINE cell, or passes through the marker's current
 * position.
 *
 * Consecutive trail points are NOT assumed to be grid-adjacent: the cells
 * between each pair are interpolated (Bresenham) so a fast-moving or
 * sparsely-recorded trail cannot tunnel through a line.
 *
 * A confirmed border (BORDER) cell is always safe: even if a checked cell's
 * coordinates match the marker's position there, no collision is reported
 * (docs/plan.md §3.4 / §7.1: "確定境界線上のマーカーには敵は無害").
 */
export function checkCollision(field: Field, trail: Point[], markerPosition: Point): boolean {
  for (let i = 0; i < trail.length; i++) {
    if (cellHits(field, trail[i], markerPosition)) {
      return true;
    }
    if (i + 1 < trail.length) {
      for (const cell of cellsBetween(trail[i], trail[i + 1])) {
        if (cellHits(field, cell, markerPosition)) {
          return true;
        }
      }
    }
  }
  return false;
}

function cellHits(field: Field, cell: Point, markerPosition: Point): boolean {
  const state = field.get(cell);
  if (state === LINE) {
    return true;
  }
  return cell.x === markerPosition.x && cell.y === markerPosition.y && state !== BORDER;
}

/**
 * Grid cells strictly between `a` and `b` along a Bresenham line
 * (endpoints excluded — callers check those themselves). Returns an empty
 * array for identical or grid-adjacent (incl. diagonal) points.
 */
function cellsBetween(a: Point, b: Point): Point[] {
  const cells: Point[] = [];
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
    cells.push({ x, y });
  }

  return cells;
}
