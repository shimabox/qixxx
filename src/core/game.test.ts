import { describe, it, expect } from 'vitest';
import { Field, CLAIMED_FAST, LINE, UNCLAIMED } from './field';
import { Game } from './game';
import { Wisp } from './enemy';
import { INITIAL_LIVES } from '../config';

describe('Game', () => {
  it('does nothing when no direction is held', () => {
    const field = new Field(6, 5);
    const game = new Game(field, { x: 2, y: 0 });

    const result = game.update({ dx: 0, dy: 0, drawHeld: false });

    expect(result).toBeNull();
    expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 0 });
    expect(game.getOccupancy()).toBe(0);
  });

  it('draws a line, closes it on reaching a border cell, and claims the resulting area', () => {
    const field = new Field(6, 5); // interior x=1..4, y=1..3; enemy defaults to field center (3,2)
    // A deterministic Wisp at the same default center position, headed away
    // from the col-2 line (+x, zero jitter): since LINE cells are walkable
    // to the Wisp (docs/plan.md §3.4), a non-deterministic default Wisp could
    // otherwise wander onto the line being drawn here and cancel it before
    // the marker reaches the border, making this test flaky.
    const wisp = new Wisp({ x: 3, y: 2 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp);

    // Field height 5 -> interior rows are y=1..3, border rows are y=0 and y=4.
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (2,1) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (2,2) LINE
    const stillDrawing = game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (2,3) LINE
    const closingAtBorder = game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (2,4) BORDER: closes

    expect(stillDrawing?.lineClosed).toBe(false);
    expect(closingAtBorder?.lineClosed).toBe(true);
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 4 });

    // Enemy defaults to the field center (col 3), which is on the right side
    // of the col-2 line, so the left side (col 1) is claimed instead.
    expect(game.getField().get({ x: 1, y: 2 })).toBe(CLAIMED_FAST);
    expect(game.getOccupancy()).toBeGreaterThan(0);
  });
});

describe('Game — miss / lives / stage clear (M2, docs/plan.md §3.5 / §6)', () => {
  it('reverts the in-progress line, returns the marker to the line start, and loses a life when the Wisp touches the line', () => {
    const field = new Field(6, 5); // interior x=1..4, y=1..3; border rows/cols elsewhere
    // Constant rng (=> zero heading jitter) + a purely horizontal initial
    // heading keeps the Wisp glued to (2,1) for the few ticks this test
    // runs (docs/plan.md §4.3's "small drift" is well under half a cell).
    const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp);

    expect(game.getLives()).toBe(INITIAL_LIVES);

    // The marker's very first step off the border (2,0) -> (2,1) lands
    // exactly on the Wisp's position, which is now drawn as a LINE cell.
    game.update({ dx: 0, dy: 1, drawHeld: true });

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 0 });
    expect(field.get({ x: 2, y: 1 })).toBe(UNCLAIMED);
    expect(game.getStatus()).toBe('playing');
  });

  it('goes to gameover once lives reach zero, and stops updating afterward', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp);

    for (let attempt = 0; attempt < INITIAL_LIVES; attempt++) {
      const livesBefore = game.getLives();
      game.update({ dx: 0, dy: 1, drawHeld: true }); // repeatedly collides with the Wisp at (2,1)
      expect(game.getLives()).toBe(livesBefore - 1);
      expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 0 });
    }

    expect(game.getLives()).toBe(0);
    expect(game.getStatus()).toBe('gameover');

    // Further updates must not advance the game once it's over.
    const positionBeforeFinalUpdate = game.getMarker().getPosition();
    const livesBeforeFinalUpdate = game.getLives();
    const result = game.update({ dx: 0, dy: 1, drawHeld: true });

    expect(result).toBeNull();
    expect(game.getMarker().getPosition()).toEqual(positionBeforeFinalUpdate);
    expect(game.getLives()).toBe(livesBeforeFinalUpdate);
  });

  it('loses a life when the Wisp itself drifts onto an in-progress LINE cell (miss originates from the enemy, not the marker)', () => {
    const field = new Field(10, 6); // interior x=1..8, y=1..4; border rows/cols elsewhere
    // Deterministic rng (=> zero heading jitter) with a purely horizontal
    // initial heading (angle 0): the Wisp walks straight along row y=1,
    // approaching the drawn line from the side rather than being placed on
    // top of it — this exercises the M2 fix that lets a Wisp step onto a
    // LINE cell (docs/plan.md §3.4) instead of reflecting off it as a wall.
    const wisp = new Wisp({ x: 1, y: 1 }, () => 0.5, 0);
    const game = new Game(field, { x: 5, y: 0 }, wisp);

    // Draw a short line straight down from the top border, stopping short of
    // closing it so the LINE cells at (5,1)/(5,2) stay in progress.
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (5,1) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (5,2) LINE
    expect(field.get({ x: 5, y: 1 })).toBe(LINE);
    expect(field.get({ x: 5, y: 2 })).toBe(LINE);
    expect(game.getLives()).toBe(INITIAL_LIVES);

    // Let the Wisp drift rightward (no further marker input) until it
    // reaches column 5 on row 1 and steps onto the in-progress line.
    let missTick = -1;
    for (let tick = 0; tick < 30 && missTick === -1; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
      if (game.getLives() < INITIAL_LIVES) {
        missTick = tick;
      }
    }

    expect(missTick).toBeGreaterThanOrEqual(0);
    expect(game.getWisp().getPosition()).toEqual({ x: 5, y: 1 });
    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    // The in-progress line vanishes entirely...
    expect(field.get({ x: 5, y: 1 })).toBe(UNCLAIMED);
    expect(field.get({ x: 5, y: 2 })).toBe(UNCLAIMED);
    // ...and the marker snaps back to the border point where it began.
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.getMarker().getPosition()).toEqual({ x: 5, y: 0 });
    expect(game.getStatus()).toBe('playing');
  });

  it('reaches stageclear once occupancy meets DEFAULT_REQUIRED_OCCUPANCY (65%)', () => {
    const field = new Field(10, 5); // interior x=1..8, y=1..3 -> 24 UNCLAIMED cells initially
    // Pure-vertical heading keeps the Wisp's x fixed at 8 (the small pocket
    // to the right of the drawn line) for the handful of ticks this test runs.
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,2) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,3) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,4) BORDER: closes, claims the 18-cell left side

    expect(game.getOccupancy()).toBeCloseTo(18 / 24);
    expect(game.getStatus()).toBe('stageclear');
  });
});
