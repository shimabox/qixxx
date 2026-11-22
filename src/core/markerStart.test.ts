import { describe, it, expect } from 'vitest';
import { drawMarkerStart, markerStartCandidates, topCenterMarkerStart, MARKER_START_EDGES } from './markerStart';
import { GRID_WIDTH, GRID_HEIGHT, MARKER_START_FRACTIONS } from '../config';

describe('marker start candidates', () => {
  it('are the middle of each edge, in the order top, right, bottom, left', () => {
    expect(GRID_WIDTH).toBe(160);
    expect(GRID_HEIGHT).toBe(120);
    expect(MARKER_START_FRACTIONS).toEqual([0.5]);
    expect(markerStartCandidates(GRID_WIDTH, GRID_HEIGHT)).toEqual([
      { edge: 'top', point: { x: 80, y: 0 } },
      { edge: 'right', point: { x: 159, y: 60 } },
      { edge: 'bottom', point: { x: 80, y: 119 } },
      { edge: 'left', point: { x: 0, y: 60 } },
    ]);
  });

  it('lie on their own edge and never on a corner, on the default and on small fields', () => {
    for (const [w, h] of [
      [GRID_WIDTH, GRID_HEIGHT],
      [40, 30],
      [49, 30],
      [30, 12],
    ]) {
      const candidates = markerStartCandidates(w, h);
      expect(candidates).toHaveLength(MARKER_START_EDGES.length * MARKER_START_FRACTIONS.length);
      for (const { edge, point } of candidates) {
        const onEdge = { top: point.y === 0, bottom: point.y === h - 1, left: point.x === 0, right: point.x === w - 1 };
        expect(onEdge[edge], `${edge} ${JSON.stringify(point)} on ${w}x${h}`).toBe(true);
        const corner = (point.x === 0 || point.x === w - 1) && (point.y === 0 || point.y === h - 1);
        expect(corner, `${JSON.stringify(point)} on ${w}x${h}`).toBe(false);
      }
    }
  });

  it("compute each point as floor(edge length x fraction)", () => {
    expect(markerStartCandidates(49, 31)).toEqual([
      { edge: 'top', point: { x: 24, y: 0 } },
      { edge: 'right', point: { x: 48, y: 15 } },
      { edge: 'bottom', point: { x: 24, y: 30 } },
      { edge: 'left', point: { x: 0, y: 15 } },
    ]);
  });
});

describe('topCenterMarkerStart', () => {
  it('is the middle of the top edge, as the start has always been', () => {
    expect(topCenterMarkerStart(160)).toEqual({ edge: 'top', point: { x: 80, y: 0 } });
    expect(topCenterMarkerStart(49)).toEqual({ edge: 'top', point: { x: 24, y: 0 } });
  });
});

describe('drawMarkerStart', () => {
  it('picks candidate floor(rng() x n) of the n candidates, calling the rng exactly once', () => {
    const candidates = markerStartCandidates(GRID_WIDTH, GRID_HEIGHT);
    expect(candidates).toHaveLength(4);
    for (let i = 0; i < candidates.length; i++) {
      for (const within of [0, 0.5, 0.999]) {
        let calls = 0;
        const rng = () => {
          calls++;
          return (i + within) / candidates.length;
        };
        expect(drawMarkerStart(GRID_WIDTH, GRID_HEIGHT, rng)).toEqual(candidates[i]);
        expect(calls).toBe(1);
      }
    }
  });
});
