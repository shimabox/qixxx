import { describe, it, expect } from 'vitest';
import { checkCollision } from './collision';
import { parseField, markerAt } from './fieldFixture';

describe('checkCollision', () => {
  it('reports a hit when the enemy trail touches an in-progress LINE cell', () => {
    const parsed = parseField(`
      ##########
      #..L.....#
      #..L.....#
      #........#
      ##########
    `);
    // LINE cells are at (3,1) and (3,2). Trail: head at (5,2) with body
    // reaching back through the drawn line at (3,2).
    const trail = [
      { x: 5, y: 2 },
      { x: 4, y: 2 },
      { x: 3, y: 2 }, // this point sits on a LINE cell -> hit
      { x: 2, y: 2 },
    ];
    const markerPosition = { x: 3, y: 1 }; // top of the drawn line, also LINE

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(true);
  });

  it('reports a hit when a trail point coincides with the marker position, independent of LINE state', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      ##########
    `);
    // Marker at an UNCLAIMED coordinate (a hypothetical stand-in for future
    // enemy types) — the "shares the marker's position" rule alone must be
    // enough to report a hit, without any LINE cell involved.
    const markerPosition = { x: 5, y: 2 };
    const trail = [
      { x: 6, y: 2 },
      { x: 5, y: 2 }, // coincides with marker
    ];

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(true);
  });

  it('reports no hit when the enemy trail stays entirely within UNCLAIMED territory', () => {
    const parsed = parseField(`
      ##########
      #........#
      #....M...#
      #........#
      ##########
    `);
    const markerPosition = markerAt(parsed, 'M'); // (5,2)
    const trail = [
      { x: 8, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 1 },
    ];

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(false);
  });

  it('does not report a hit when the marker is on a confirmed outer BORDER cell, even if a trail point matches it', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      ##########
    `);
    const markerPosition = { x: 5, y: 0 };
    // A trail point that happens to share the same coordinates as the
    // border-standing marker must still be harmless (docs/plan.md §3.4/§7.1).
    const trail = [{ x: 5, y: 0 }];

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(false);
  });

  it('interpolates a straight gap of several cells and detects a LINE cell strictly between two distant trail points', () => {
    const parsed = parseField(`
      ##########
      #........#
      #..L.....#
      #........#
      ##########
    `);
    // LINE cell at (3,2). Trail jumps directly from (7,2) to (1,2) — a
    // 6-cell gap with no intermediate samples of its own — so only the
    // Bresenham interpolation between the two endpoints can find it.
    const trail = [
      { x: 7, y: 2 },
      { x: 1, y: 2 },
    ];
    const markerPosition = { x: 8, y: 3 }; // well away from the line, UNCLAIMED

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(true);
  });

  it('interpolates a diagonal gap and detects a LINE cell strictly between two distant, diagonally-placed trail points', () => {
    const parsed = parseField(`
      ##########
      #........#
      #...L....#
      #........#
      #........#
      ##########
    `);
    // LINE cell at (4,2). Trail jumps diagonally from (1,1) to (7,3) — the
    // Bresenham path between them (favoring the longer axis, x) passes
    // through (4,2) partway along.
    const trail = [
      { x: 1, y: 1 },
      { x: 7, y: 3 },
    ];
    const markerPosition = { x: 8, y: 4 }; // well away, UNCLAIMED

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(true);
  });

  it('does not mutate the trail array or its points', () => {
    const parsed = parseField(`
      ##########
      #..L.....#
      #..L.....#
      #........#
      ##########
    `);
    const trail = [
      { x: 5, y: 2 },
      { x: 4, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 2 },
    ];
    const trailSnapshot = trail.map((p) => ({ ...p }));
    const markerPosition = { x: 3, y: 1 };

    checkCollision(parsed.field, trail, markerPosition);

    expect(trail).toEqual(trailSnapshot);
    expect(trail.length).toBe(trailSnapshot.length);
  });

  it('does not report a hit when the marker is on an internal (already-closed-line) BORDER cell', () => {
    const parsed = parseField(`
      ##########
      #...#....#
      #...#....#
      #...#....#
      ##########
    `);
    // Internal BORDER column at x=4 (a previously-closed line kept as BORDER
    // because it still separates two UNCLAIMED regions).
    const markerPosition = { x: 4, y: 2 };
    const trail = [{ x: 4, y: 2 }];

    expect(checkCollision(parsed.field, trail, markerPosition)).toBe(false);
  });
});
