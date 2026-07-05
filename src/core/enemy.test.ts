import { describe, it, expect } from 'vitest';
import { Wisp } from './enemy';
import { Point, UNCLAIMED } from './field';
import { WISP_HISTORY_LENGTH, WISP_SPEED } from '../config';
import { parseField, markerAt } from './fieldFixture';

/**
 * Builds a wide-open field (only the outer BORDER ring, no obstacles) with a
 * single 'W' marker placed at (startX, startY), so a Wisp can travel many
 * cells in a straight line without ever reflecting off a wall.
 */
function openField(width: number, height: number, startX: number, startY: number) {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        row += '#';
      } else if (x === startX && y === startY) {
        row += 'W';
      } else {
        row += '.';
      }
    }
    rows.push(row);
  }
  return parseField(rows.join('\n'));
}

/**
 * Reproduces the documented movement model (docs/plan.md §4.3 / enemy.ts
 * header): a continuous position that advances by WISP_SPEED per tick along
 * a fixed heading, snapped to the nearest grid cell. Computes the exact,
 * head-first sequence of *distinct* cells a straight-line (zero jitter, zero
 * vertical component) Wisp should have recorded after `ticks` updates,
 * independent of Wisp's own internal history bookkeeping.
 */
function expectedDistinctTrail(start: Point, ticks: number): Point[] {
  const distinct: Point[] = [{ ...start }];
  let x = start.x;
  for (let t = 0; t < ticks; t++) {
    x += WISP_SPEED;
    const cell = { x: Math.round(x), y: start.y };
    const last = distinct[distinct.length - 1];
    if (cell.x !== last.x || cell.y !== last.y) {
      distinct.push(cell);
    }
  }
  return distinct;
}

describe('Wisp', () => {
  it('never leaves UNCLAIMED territory, reflecting off walls with a deterministic rng', () => {
    const parsed = parseField(`
      ########
      #......#
      #......#
      #..W...#
      #......#
      ########
    `);
    const start = markerAt(parsed, 'W');
    // Deterministic rng: 0.5 => zero heading jitter ((0.5*2-1) * JITTER = 0),
    // so the only direction changes come from wall reflections. Heading
    // straight along +x (angle 0) drives it directly into the right wall.
    const rng = () => 0.5;
    const wisp = new Wisp(start, rng, 0);

    for (let tick = 0; tick < 500; tick++) {
      wisp.update(parsed.field);
      const pos = wisp.getPosition();
      expect(parsed.field.isInBounds(pos)).toBe(true);
      expect(parsed.field.get(pos)).toBe(UNCLAIMED);
    }
  });

  it('never leaves UNCLAIMED territory when jitter is applied every tick (deterministic rng sequence)', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #....W...#
      #........#
      #........#
      ##########
    `);
    const start = markerAt(parsed, 'W');
    // A simple deterministic pseudo-random sequence (not Math.random) so the
    // test is reproducible while still exercising varied jitter each tick.
    let seed = 1;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const wisp = new Wisp(start, rng);

    for (let tick = 0; tick < 1000; tick++) {
      wisp.update(parsed.field);
      const pos = wisp.getPosition();
      expect(parsed.field.isInBounds(pos)).toBe(true);
      expect(parsed.field.get(pos)).toBe(UNCLAIMED);
    }
  });

  it('records only distinct cells (not per-tick samples), capped at WISP_HISTORY_LENGTH, once the head has crossed many cells', () => {
    const parsed = openField(40, 5, 2, 2);
    const start = markerAt(parsed, 'W');
    // Deterministic rng: 0.5 => zero heading jitter; heading straight along
    // +x (angle 0) makes the trail-cell sequence exactly predictable.
    const wisp = new Wisp(start, () => 0.5, 0);

    expect(wisp.getTrail()).toEqual([start]);

    const ticks = 60; // 60 * WISP_SPEED (0.3) = 18 cells travelled, well over the cap
    for (let tick = 0; tick < ticks; tick++) {
      wisp.update(parsed.field);
    }

    const allDistinct = expectedDistinctTrail(start, ticks);
    expect(allDistinct.length).toBeGreaterThan(WISP_HISTORY_LENGTH);
    const expectedTrail = allDistinct.slice(-WISP_HISTORY_LENGTH).reverse();

    const trail = wisp.getTrail();
    expect(trail.length).toBe(WISP_HISTORY_LENGTH);
    expect(trail).toEqual(expectedTrail);
    expect(trail[0]).toEqual(wisp.getPosition());
  });

  it('records exactly the distinct cells traversed so far when still under the history cap', () => {
    const parsed = openField(40, 5, 2, 2);
    const start = markerAt(parsed, 'W');
    const wisp = new Wisp(start, () => 0.5, 0);

    const ticks = 15; // 15 * WISP_SPEED (0.3) = 4.5 cells travelled, under the cap
    for (let tick = 0; tick < ticks; tick++) {
      wisp.update(parsed.field);
    }

    const expectedTrail = expectedDistinctTrail(start, ticks).reverse();
    expect(expectedTrail.length).toBeLessThan(WISP_HISTORY_LENGTH);

    const trail = wisp.getTrail();
    expect(trail).toEqual(expectedTrail);
    expect(trail[0]).toEqual(wisp.getPosition());
  });

  it('does not treat an in-progress LINE cell as a wall: the head walks straight onto and across it', () => {
    const parsed = parseField(`
      ########
      #......#
      #.WLL..#
      #......#
      ########
    `);
    const start = markerAt(parsed, 'W');
    const wisp = new Wisp(start, () => 0.5, 0); // heading straight along +x

    for (let tick = 0; tick < 12; tick++) {
      wisp.update(parsed.field);
    }

    // With WISP_SPEED = 0.3, 12 ticks advance the head 3.6 cells to the
    // right, i.e. onto/through the two LINE cells without reflecting.
    expect(wisp.getPosition()).toEqual({ x: start.x + 4, y: start.y });
  });
});
