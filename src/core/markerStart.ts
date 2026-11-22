// Where the marker starts a stage. Stage 1 always starts at the middle of the
// top edge, so a new player's first stage looks the same every time. From
// stage 2 the start is drawn from the candidates — the points at each of
// MARKER_START_FRACTIONS (the middle, 1/2) along each of the four edges — so
// the opening move of a stage is no longer the same every time.
//
// The candidate order is fixed (edges top, right, bottom, left; on each edge
// the fractions in MARKER_START_FRACTIONS order): with n candidates, a
// stage's start is the candidate at index floor(rng() * n), and a replay
// only reproduces it if this order never changes.
import { Point } from './field';
import type { Rng } from './enemy';
import { MARKER_START_FRACTIONS } from '../config';

export type MarkerStartEdge = 'top' | 'right' | 'bottom' | 'left';

export interface MarkerStart {
  edge: MarkerStartEdge;
  point: Point;
}

export const MARKER_START_EDGES: readonly MarkerStartEdge[] = ['top', 'right', 'bottom', 'left'];

/** The start of stage 1 (and of any stage that does not draw one): the middle of the top edge. */
export function topCenterMarkerStart(width: number): MarkerStart {
  return { edge: 'top', point: { x: Math.floor(width / 2), y: 0 } };
}

/** The point at `fraction` along `edge` of a `width` x `height` field. */
function pointOn(edge: MarkerStartEdge, fraction: number, width: number, height: number): Point {
  switch (edge) {
    case 'top':
      return { x: Math.floor(width * fraction), y: 0 };
    case 'bottom':
      return { x: Math.floor(width * fraction), y: height - 1 };
    case 'left':
      return { x: 0, y: Math.floor(height * fraction) };
    case 'right':
      return { x: width - 1, y: Math.floor(height * fraction) };
  }
}

/** Every candidate start of a `width` x `height` field, in the fixed order described above. */
export function markerStartCandidates(width: number, height: number): MarkerStart[] {
  const candidates: MarkerStart[] = [];
  for (const edge of MARKER_START_EDGES) {
    for (const fraction of MARKER_START_FRACTIONS) {
      candidates.push({ edge, point: pointOn(edge, fraction, width, height) });
    }
  }
  return candidates;
}

/** Draws one candidate with equal probability, calling `rng` exactly once. */
export function drawMarkerStart(width: number, height: number, rng: Rng): MarkerStart {
  const candidates = markerStartCandidates(width, height);
  const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
  return candidates[index];
}
