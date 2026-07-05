import { describe, it, expect } from 'vitest';
import { Field, CLAIMED_FAST } from './field';
import { Game } from './game';

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
    const game = new Game(field, { x: 2, y: 0 });

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
