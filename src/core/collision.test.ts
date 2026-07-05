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
