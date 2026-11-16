import { describe, expect, it } from 'vitest';
import { Field, CLAIMED_FAST, BORDER } from '../core/field';
import { hintArrowDirection, hintMarkShapes, hintPulse } from './hintLayer';
import { HINT_ARROW_LENGTH_CELLS, HINT_RING_RADIUS_CELLS, RENDER_SCALE } from '../config';

describe('hintArrowDirection', () => {
  const field = new Field(20, 15);

  it('points into the field, across the edge the marker is on', () => {
    expect(hintArrowDirection(field, { x: 10, y: 0 })).toEqual({ dx: 0, dy: 1 });
    expect(hintArrowDirection(field, { x: 10, y: 14 })).toEqual({ dx: 0, dy: -1 });
    expect(hintArrowDirection(field, { x: 0, y: 7 })).toEqual({ dx: 1, dy: 0 });
    expect(hintArrowDirection(field, { x: 19, y: 7 })).toEqual({ dx: -1, dy: 0 });
  });

  it('has none on an outer corner, where no step leads into the field', () => {
    expect(hintArrowDirection(field, { x: 0, y: 0 })).toBeNull();
    expect(hintArrowDirection(field, { x: 19, y: 14 })).toBeNull();
  });

  it('points toward the unclaimed side of a border between claimed and unclaimed cells', () => {
    const f = new Field(20, 15);
    for (let y = 1; y < 14; y++) {
      for (let x = 1; x < 5; x++) f.set({ x, y }, CLAIMED_FAST);
      f.set({ x: 5, y }, BORDER);
    }
    expect(hintArrowDirection(f, { x: 5, y: 7 })).toEqual({ dx: 1, dy: 0 });
  });

  it('takes the way away from the nearer outer edge when several lead in', () => {
    const f = new Field(20, 15);
    // An inner border cell with unclaimed cells below and to the right.
    f.set({ x: 3, y: 2 }, BORDER);
    f.set({ x: 2, y: 2 }, BORDER);
    f.set({ x: 3, y: 1 }, BORDER);
    expect(hintArrowDirection(f, { x: 3, y: 2 })).toEqual({ dx: 0, dy: 1 });
  });
});

describe('hintMarkShapes', () => {
  it('rings every target, centered on its cell, about HINT_RING_RADIUS_CELLS across', () => {
    const shapes = hintMarkShapes({ kind: 'ring', centers: [{ x: 10, y: 20 }, { x: 30, y: 5 }] }, 0, false)!;
    expect(shapes.arrow).toBeNull();
    expect(shapes.rings.map((r) => [r.x, r.y])).toEqual([
      [10.5 * RENDER_SCALE, 20.5 * RENDER_SCALE],
      [30.5 * RENDER_SCALE, 5.5 * RENDER_SCALE],
    ]);
    for (const ring of shapes.rings) {
      expect(ring.radius).toBeLessThanOrEqual(HINT_RING_RADIUS_CELLS * RENDER_SCALE);
      expect(ring.radius).toBeGreaterThan(HINT_RING_RADIUS_CELLS * RENDER_SCALE * 0.8);
    }
  });

  it('has nothing to draw without a mark or without targets', () => {
    expect(hintMarkShapes(null, 0, false)).toBeNull();
    expect(hintMarkShapes({ kind: 'ring', centers: [] }, 0, false)).toBeNull();
  });

  it('draws the arrow from beside the marker HINT_ARROW_LENGTH_CELLS into the field', () => {
    const shapes = hintMarkShapes({ kind: 'arrow', from: { x: 80, y: 0 }, dir: { dx: 0, dy: 1 } }, 0, false)!;
    expect(shapes.rings).toEqual([]);
    const arrow = shapes.arrow!;
    expect(arrow.x0).toBe(80.5 * RENDER_SCALE);
    expect(arrow.x1).toBe(80.5 * RENDER_SCALE);
    expect(arrow.y1 - arrow.y0).toBe(HINT_ARROW_LENGTH_CELLS * RENDER_SCALE);
    expect(arrow.y0).toBeGreaterThan(0.5 * RENDER_SCALE);
  });

  it('pulses with the age, and holds still with reduced motion', () => {
    const ring = { kind: 'ring' as const, centers: [{ x: 5, y: 5 }] };
    const arrow = { kind: 'arrow' as const, from: { x: 0, y: 5 }, dir: { dx: 1, dy: 0 } };
    const moving = [0, 10, 20, 30].map((age) => hintMarkShapes(ring, age, false)!.rings[0]);
    expect(new Set(moving.map((r) => r.radius)).size).toBeGreaterThan(1);
    expect(new Set(moving.map((r) => r.alpha)).size).toBeGreaterThan(1);
    expect(new Set([0, 10, 20].map((age) => hintMarkShapes(arrow, age, false)!.arrow!.alpha)).size).toBeGreaterThan(1);

    const still = [0, 7, 13, 20, 33, 89].map((age) => hintMarkShapes(ring, age, true)!.rings[0]);
    expect(new Set(still.map((r) => r.radius)).size).toBe(1);
    expect(new Set(still.map((r) => r.alpha)).size).toBe(1);
    expect(new Set([0, 7, 13, 20].map((age) => JSON.stringify(hintMarkShapes(arrow, age, true)!.arrow))).size).toBe(1);
    expect(hintPulse(5, true)).toBe(1);
  });
});
