import { describe, it, expect } from 'vitest';
import { claimArea, pruneDeadBorders } from './claim';
import { CLAIMED_FAST, CLAIMED_SLOW, UNCLAIMED, BORDER } from './field';
import { parseField, renderField, pathFrom, markerAt } from './fieldFixture';

describe('claimArea', () => {
  it('claims the side without the enemy for a simple vertical rectangle line', () => {
    const parsed = parseField(`
      ##########
      #..Q.....#
      #........#
      #........#
      #........#
      ##########
    `);
    const enemyPos = markerAt(parsed, 'Q');
    const line = pathFrom('(5,0) D D D D');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    // Left side (with the enemy) stays open and its border is untouched;
    // the right side is claimed. The line itself stays BORDER because it
    // still borders the (still-unclaimed) left side.
    expect(renderField(parsed.field)).toBe(
      ['##########', '#....#fff#', '#....#fff#', '#....#fff#', '#....#fff#', '##########'].join('\n')
    );
    expect(result.claimedCells).toBe(12);
    expect(result.occupancy).toBeCloseTo(12 / 32);
  });

  it('flips which side is claimed when the enemy position is mirrored', () => {
    const parsed = parseField(`
      ##########
      #.....Q..#
      #........#
      #........#
      #........#
      ##########
    `);
    const enemyPos = markerAt(parsed, 'Q');
    const line = pathFrom('(5,0) D D D D');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    expect(parsed.field.get({ x: 2, y: 2 })).toBe(CLAIMED_FAST); // left side, now claimed
    expect(parsed.field.get({ x: 7, y: 2 })).toBe(UNCLAIMED); // right side (enemy's), stays UNCLAIMED
    expect(result.claimedCells).toBe(16);
    expect(result.occupancy).toBeCloseTo(16 / 32);
  });

  it('correctly splits an L-shaped (bent) line', () => {
    const parsed = parseField(`
      ############
      #..........#
      #..........#
      #..........#
      #..........#
      #..........#
      #..........#
      ############
    `);
    const enemyPos = { x: 8, y: 5 };
    const line = pathFrom('(6,0) D D D R R R R R');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    // The pocket carved by the L (upper-right corner) is unreachable and claimed.
    expect(parsed.field.get({ x: 7, y: 1 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 10, y: 2 })).toBe(CLAIMED_FAST);
    // The rest of the field (including the enemy) stays open.
    expect(parsed.field.get({ x: 2, y: 2 })).toBe(UNCLAIMED);
    expect(parsed.field.get({ x: 8, y: 5 })).toBe(UNCLAIMED);
    expect(result.claimedCells).toBe(8);
  });

  it('correctly splits a U-shaped (コの字) line', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      #........#
      #........#
      #........#
      ##########
    `);
    const enemyPos = { x: 8, y: 4 };
    const line = pathFrom('(3,0) D D D R R R U U U');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    // The pocket enclosed by the U (between the two vertical walls, above the base) is claimed.
    expect(parsed.field.get({ x: 4, y: 1 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 5, y: 2 })).toBe(CLAIMED_FAST);
    // Everything else stays open.
    expect(parsed.field.get({ x: 1, y: 1 })).toBe(UNCLAIMED);
    expect(parsed.field.get({ x: 8, y: 4 })).toBe(UNCLAIMED);
    expect(result.claimedCells).toBe(4);
  });

  it('correctly splits a multi-turn (staircase/spiral-like) line', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      #........#
      #........#
      #........#
      ##########
    `);
    const enemyPos = { x: 7, y: 1 };
    const line = pathFrom('(2,0) D D D R R R R D D D D');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    // Left/bottom-left component (18 cells) is cut off from the enemy and claimed.
    expect(parsed.field.get({ x: 1, y: 1 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 3, y: 5 })).toBe(CLAIMED_FAST);
    // Right/top-right component (with the enemy) stays open.
    expect(parsed.field.get({ x: 7, y: 5 })).toBe(UNCLAIMED);
    expect(result.claimedCells).toBe(18);
    expect(result.occupancy).toBeCloseTo(18 / 48);
  });

  it('claims a width-1 sliver running along the outer border', () => {
    const parsed = parseField(`
      ########
      #......#
      #......#
      #......#
      #......#
      ########
    `);
    const enemyPos = { x: 4, y: 2 };
    const line = pathFrom('(2,0) D D D D D');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    expect(parsed.field.get({ x: 1, y: 1 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 1, y: 4 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 5, y: 3 })).toBe(UNCLAIMED);
    expect(result.claimedCells).toBe(4);
    expect(result.occupancy).toBeCloseTo(4 / 24);
  });

  it('uses an already-claimed area border as the line start point', () => {
    const parsed = parseField(`
      ##########
      #ff#.....#
      #ff#.....#
      ####.....#
      #........#
      #........#
      #........#
      ##########
    `);
    const startOnClaimedBorder = { x: 3, y: 2 };
    const line = pathFrom('(3,2) R R R R R R');
    const enemyPos = { x: 4, y: 4 };

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    expect(parsed.field.get(startOnClaimedBorder)).toBe(BORDER);
    // Row 1's pocket (cut off by the new line at y=2) becomes claimed.
    expect(parsed.field.get({ x: 5, y: 1 })).toBe(CLAIMED_FAST);
    // The lower region (with the enemy) stays open.
    expect(parsed.field.get({ x: 7, y: 5 })).toBe(UNCLAIMED);
    // The pre-existing claimed block is untouched.
    expect(parsed.field.get({ x: 1, y: 1 })).toBe(CLAIMED_FAST);
    expect(result.claimedCells).toBe(5);
  });

  it('reports occupancy that matches the exact claimed cell count and never exceeds 100%', () => {
    const parsed = parseField(`
      ##########
      #..Q.....#
      #........#
      #........#
      #........#
      ##########
    `);
    const enemyPos = markerAt(parsed, 'Q');
    const line = pathFrom('(5,0) D D D D');

    const result = claimArea(parsed.field, line, enemyPos, 'fast');

    const totalClaimed =
      parsed.field.getCellsOfState(CLAIMED_FAST).length + parsed.field.getCellsOfState(CLAIMED_SLOW).length;
    expect(result.occupancy).toBeCloseTo(totalClaimed / 32);
    expect(result.occupancy).toBeGreaterThan(0);
    expect(result.occupancy).toBeLessThanOrEqual(1);
  });
});

describe('pruneDeadBorders', () => {
  it('converts a fully-enclosed interior border segment (a dead former line) into claimed cells', () => {
    // An interior wall at x=3 with claimed area on both sides, all inside
    // the field's permanent outer ring.
    const parsed = parseField(`
      #######
      #ff#ff#
      #ff#ff#
      #ff#ff#
      #ff#ff#
      #ff#ff#
      #######
    `);

    pruneDeadBorders(parsed.field);

    // The dead interior segment is converted...
    expect(parsed.field.get({ x: 3, y: 1 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 3, y: 3 })).toBe(CLAIMED_FAST);
    expect(parsed.field.get({ x: 3, y: 5 })).toBe(CLAIMED_FAST);
    // ...but the field's permanent outer ring is never pruned, even though
    // every interior cell is now claimed (docs/plan.md §4.2: pruning only
    // applies to a former *line* embedded in claimed area, not the wall).
    expect(parsed.field.getCellsOfState(BORDER).length).toBe(24); // full outer ring, untouched
    expect(parsed.field.get({ x: 0, y: 0 })).toBe(BORDER);
    expect(parsed.field.get({ x: 6, y: 6 })).toBe(BORDER);
  });

  it('leaves an interior border cell alone when an unclaimed neighbor exists (including diagonals)', () => {
    const parsed = parseField(`
      #######
      #f.#ff#
      #ff#ff#
      #ff#ff#
      #ff#ff#
      #ff#ff#
      #######
    `);

    pruneDeadBorders(parsed.field);

    // (3,1) has a direct unclaimed neighbor at (2,1): not pruned.
    expect(parsed.field.get({ x: 3, y: 1 })).toBe(BORDER);
    // (3,2) has only a diagonal unclaimed neighbor at (2,1): still not pruned
    // (8-neighborhood check).
    expect(parsed.field.get({ x: 3, y: 2 })).toBe(BORDER);
    // Far from the lone unclaimed cell, fully surrounded by claimed cells: pruned.
    expect(parsed.field.get({ x: 3, y: 4 })).toBe(CLAIMED_FAST);
  });
});
