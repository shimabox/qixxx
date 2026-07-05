import { describe, it, expect } from 'vitest';
import { Field, UNCLAIMED, LINE, CLAIMED_FAST } from './field';
import { Marker } from './marker';

// A small 6x5 field: border ring (rows 0/4, cols 0/5), interior x=1..4, y=1..3.
function makeField(): Field {
  return new Field(6, 5);
}

describe('Marker', () => {
  it('moves freely along BORDER cells without the draw button held', () => {
    const field = makeField();
    const marker = new Marker({ x: 2, y: 0 });

    const result = marker.tryMove(field, 1, 0, false);

    expect(result.moved).toBe(true);
    expect(result.lineClosed).toBe(false);
    expect(marker.getPosition()).toEqual({ x: 3, y: 0 });
  });

  it('cannot enter an UNCLAIMED cell without the draw button held', () => {
    const field = makeField();
    const marker = new Marker({ x: 2, y: 0 });

    const result = marker.tryMove(field, 0, 1, false);

    expect(result.moved).toBe(false);
    expect(marker.getPosition()).toEqual({ x: 2, y: 0 });
    expect(field.get({ x: 2, y: 1 })).toBe(UNCLAIMED);
  });

  it('enters UNCLAIMED and draws a LINE cell when the draw button is held', () => {
    const field = makeField();
    const marker = new Marker({ x: 2, y: 0 });

    const result = marker.tryMove(field, 0, 1, true);

    expect(result.moved).toBe(true);
    expect(marker.isDrawing()).toBe(true);
    expect(marker.getPosition()).toEqual({ x: 2, y: 1 });
    expect(field.get({ x: 2, y: 1 })).toBe(LINE);
    expect(marker.getLine()).toEqual([{ x: 2, y: 1 }]);
  });

  it('closes the line upon reaching a different border cell', () => {
    const field = makeField();
    const marker = new Marker({ x: 2, y: 0 });

    marker.tryMove(field, 0, 1, true); // -> (2,1) LINE
    marker.tryMove(field, 0, 1, true); // -> (2,2) LINE
    marker.tryMove(field, 0, 1, true); // -> (2,3) LINE
    const closing = marker.tryMove(field, 0, 1, true); // -> (2,4) BORDER: closes

    expect(closing.moved).toBe(true);
    expect(closing.lineClosed).toBe(true);
    expect(closing.closedLine).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ]);
    expect(marker.isDrawing()).toBe(false);
    expect(marker.getLine()).toEqual([]);
    expect(marker.getPosition()).toEqual({ x: 2, y: 4 });
  });

  it('rejects a move that would self-intersect the in-progress line', () => {
    const field = makeField();
    const marker = new Marker({ x: 3, y: 0 });

    marker.tryMove(field, 0, 1, true); // -> (3,1)
    marker.tryMove(field, 0, 1, true); // -> (3,2)
    marker.tryMove(field, 1, 0, true); // -> (4,2)
    marker.tryMove(field, 0, -1, true); // -> (4,1)

    // Moving left from (4,1) targets (3,1), which is already LINE and is not
    // the retract target (line[length-2] is (4,2)) -> self-intersection.
    const result = marker.tryMove(field, -1, 0, true);

    expect(result.moved).toBe(false);
    expect(marker.getPosition()).toEqual({ x: 4, y: 1 });
    expect(marker.getLine().length).toBe(4);
    expect(field.get({ x: 3, y: 1 })).toBe(LINE);
  });

  it('retracts the trailing LINE cell when moving backward, without requiring the draw button', () => {
    const field = makeField();
    const marker = new Marker({ x: 3, y: 0 });

    marker.tryMove(field, 0, 1, true); // -> (3,1)
    marker.tryMove(field, 0, 1, true); // -> (3,2)

    const retract = marker.tryMove(field, 0, -1, false); // back to (3,1)

    expect(retract.moved).toBe(true);
    expect(retract.retracted).toBe(true);
    expect(marker.getPosition()).toEqual({ x: 3, y: 1 });
    expect(field.get({ x: 3, y: 2 })).toBe(UNCLAIMED);
    expect(marker.getLine()).toEqual([{ x: 3, y: 1 }]);
    expect(marker.isDrawing()).toBe(true);
  });

  it('resumes normal border movement once retracted all the way to the start point', () => {
    const field = makeField();
    const marker = new Marker({ x: 3, y: 0 });

    marker.tryMove(field, 0, 1, true); // -> (3,1)
    marker.tryMove(field, 0, -1, false); // retract back to (3,0)

    expect(marker.isDrawing()).toBe(false);
    expect(marker.getLine()).toEqual([]);
    expect(field.get({ x: 3, y: 1 })).toBe(UNCLAIMED);
    expect(marker.getPosition()).toEqual({ x: 3, y: 0 });

    // Normal border movement works again.
    const borderMove = marker.tryMove(field, 1, 0, false);
    expect(borderMove.moved).toBe(true);
    expect(marker.getPosition()).toEqual({ x: 4, y: 0 });
  });

  it('cannot walk onto CLAIMED cells (they are filled area, not a path)', () => {
    const field = makeField();
    field.set({ x: 2, y: 1 }, CLAIMED_FAST);
    const marker = new Marker({ x: 2, y: 0 });

    const result = marker.tryMove(field, 0, 1, true);

    expect(result.moved).toBe(false);
    expect(marker.getPosition()).toEqual({ x: 2, y: 0 });
  });

  it('rejects retract when retractEnabled is disabled (design hook for post-fuse M3 behavior)', () => {
    const field = makeField();
    const marker = new Marker({ x: 3, y: 0 }, { retractEnabled: false });

    marker.tryMove(field, 0, 1, true); // -> (3,1)
    marker.tryMove(field, 0, 1, true); // -> (3,2)

    const result = marker.tryMove(field, 0, -1, true); // attempt to back up to (3,1)

    expect(result.moved).toBe(false);
    expect(result.retracted).toBe(false);
    expect(marker.getPosition()).toEqual({ x: 3, y: 2 });
    expect(marker.getLine().length).toBe(2);
  });

  it('rejects invalid (diagonal or zero) move inputs', () => {
    const field = makeField();
    const marker = new Marker({ x: 2, y: 0 });

    expect(marker.tryMove(field, 0, 0, false).moved).toBe(false);
    expect(marker.tryMove(field, 1, 1, false).moved).toBe(false);
  });
});
