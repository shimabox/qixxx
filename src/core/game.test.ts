import { describe, it, expect } from 'vitest';
import { Field, CLAIMED_FAST, CLAIMED_SLOW, LINE, UNCLAIMED } from './field';
import { Game, GameInput } from './game';
import { Wisp } from './enemy';
import { Ember } from './patrol';
import {
  INITIAL_LIVES,
  MISS_GRACE_TICKS,
  MARKER_MOVE_TICKS_SLOW,
  IGNITER_SPAWN_STILL_TICKS,
} from '../config';

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
      // Drawing onto (2,1) lands on the Wisp's trail (the Wisp patrols row
      // y=1 back and forth, so (2,1) is always among its recent distinct
      // cells) -> a deliberate miss on every attempt.
      game.update({ dx: 0, dy: 1, drawHeld: true });
      expect(game.getLives()).toBe(livesBefore - 1);
      expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 0 });

      // Burn off the post-miss grace period (M3, docs/plan.md §3.5) before
      // the next deliberate miss — misses can no longer occur back-to-back.
      // (A no-op after the final attempt, once the game is already over.)
      for (let tick = 0; tick < MISS_GRACE_TICKS; tick++) {
        game.update({ dx: 0, dy: 0, drawHeld: false });
      }
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

describe('Game — low/high speed lines and scoring (M3, docs/plan.md §3.2/§3.6/§5.1)', () => {
  it('halves the marker movement rate while the slow button is held', () => {
    // This test's tick-by-tick expectations below assume 2 ticks/cell.
    expect(MARKER_MOVE_TICKS_SLOW).toBe(2);

    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 5, y: 2 }, () => 0.5, 0); // parked away from the top border row
    const game = new Game(field, { x: 1, y: 0 }, wisp);

    // Tick 1: always moves (the cooldown starts at 0).
    const tick1 = game.update({ dx: 1, dy: 0, drawHeld: false, slow: true });
    expect(tick1?.moved).toBe(true);
    expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 0 });

    // Tick 2: still on cooldown -> no move is even attempted.
    const tick2 = game.update({ dx: 1, dy: 0, drawHeld: false, slow: true });
    expect(tick2).toBeNull();
    expect(game.getMarker().getPosition()).toEqual({ x: 2, y: 0 });

    // Tick 3: cooldown elapsed -> moves again.
    const tick3 = game.update({ dx: 1, dy: 0, drawHeld: false, slow: true });
    expect(tick3?.moved).toBe(true);
    expect(game.getMarker().getPosition()).toEqual({ x: 3, y: 0 });
  });

  it('claims a slow-drawn line as CLAIMED_SLOW and scores it at the slow (double) per-cell rate, plus the stage-clear bonus', () => {
    const field = new Field(10, 5); // interior x=1..8, y=1..3 -> 24 UNCLAIMED cells initially
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2); // vertical heading, x pinned at 8 (see stageclear test above)
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    expect(game.getScore()).toBe(0);

    const slowInput: GameInput = { dx: 0, dy: 1, drawHeld: true, slow: true };
    for (let step = 0; step < 4; step++) {
      game.update(slowInput); // moves one cell
      game.update(slowInput); // cooldown tick (MARKER_MOVE_TICKS_SLOW = 2): no-op once already at stageclear
    }

    expect(game.getField().get({ x: 1, y: 2 })).toBe(CLAIMED_SLOW);
    expect(game.getOccupancy()).toBeCloseTo(18 / 24);
    expect(game.getStatus()).toBe('stageclear');
    // 18 cells * 1.0 pt (slow) * multiplier 1 = 18, plus the (75% - 65%) * 100 = 1000 stage-clear bonus.
    expect(game.getScore()).toBe(1018);
  });

  it('closes a mixed fast/slow line as fast (docs/plan.md §3.2) and scores it at the fast rate', () => {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1) fast; cooldown 0 after
    game.update({ dx: 0, dy: 1, drawHeld: true, slow: true }); // -> (7,2) slow; cooldown 1 after (mixes the line)
    // Still paying off the slow step's cooldown: no move is attempted yet.
    const waiting = game.update({ dx: 0, dy: 1, drawHeld: true });
    expect(waiting).toBeNull();
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,3) fast
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,4) BORDER: closes

    expect(game.getField().get({ x: 1, y: 2 })).toBe(CLAIMED_FAST);
    expect(game.getStatus()).toBe('stageclear');
    // 18 cells * 0.5 pt (fast, since at least one cell was fast) + 1000 stage-clear bonus.
    expect(game.getScore()).toBe(9 + 1000);
  });

  it('resets the score multiplier to 1 on a miss', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp, undefined, { multiplier: 5 });

    expect(game.getMultiplier()).toBe(5);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // steps onto the Wisp's LINE cell -> miss

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.getMultiplier()).toBe(1);
  });
});

describe('Game — Ember collision (M3, docs/plan.md §3.4 (2))', () => {
  it('loses a life when an Ember touches the marker', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 3, y: 2 }, () => 0.5, 0); // parked away from the action
    // Starts one cell to the left of the marker, heading right along the top
    // border row -> steps directly onto the marker's (stationary) position
    // on Ember's very first move.
    const ember = new Ember({ x: 2, y: 0 }, { dx: 1, dy: 0 });
    const game = new Game(field, { x: 3, y: 0 }, wisp, undefined, { embers: [ember] });

    expect(game.getLives()).toBe(INITIAL_LIVES);

    game.update({ dx: 0, dy: 0, drawHeld: false });

    expect(game.getEmberPositions()).toContainEqual({ x: 3, y: 0 });
    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.getStatus()).toBe('playing');
  });

  it('does not collide while the Ember stays away from the marker', () => {
    const field = new Field(10, 6);
    const wisp = new Wisp({ x: 5, y: 3 }, () => 0.5, 0);
    const ember = new Ember({ x: 0, y: 0 }, { dx: 1, dy: 0 }); // far from the marker below
    const game = new Game(field, { x: 5, y: 5 }, wisp, undefined, { embers: [ember] });

    for (let tick = 0; tick < 10; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }

    expect(game.getLives()).toBe(INITIAL_LIVES);
    expect(game.getStatus()).toBe('playing');
  });
});

describe('Game — post-miss grace period (M3 fix, docs/plan.md §3.5)', () => {
  // Builds a game where an Ember is pinned onto the stationary marker's
  // cell indefinitely: both of the Ember's BORDER neighbors are converted
  // to CLAIMED_FAST, so it has no candidate cell to move to and holds its
  // position — a permanent enemy-on-marker contact. Without the grace
  // period, this exact situation (a real one: an Ember reaching a
  // stationary marker) re-triggered a miss every tick and drained all
  // three lives from a single contact.
  function makePinnedContactGame() {
    const field = new Field(6, 5);
    field.set({ x: 2, y: 0 }, CLAIMED_FAST);
    field.set({ x: 4, y: 0 }, CLAIMED_FAST);
    const wisp = new Wisp({ x: 3, y: 2 }, () => 0.5, 0); // patrols row 2; harmless to a border-standing marker
    const ember = new Ember({ x: 3, y: 0 }, { dx: 1, dy: 0 });
    return new Game(field, { x: 3, y: 0 }, wisp, undefined, { embers: [ember] });
  }

  it('a sustained Ember contact costs exactly one life during the grace period, not one per tick', () => {
    const game = makePinnedContactGame();

    game.update({ dx: 0, dy: 0, drawHeld: false });
    expect(game.getLives()).toBe(INITIAL_LIVES - 1); // the one and only miss

    // Contact persists on every one of these ticks, but no further life is
    // lost while the grace period is active.
    for (let tick = 0; tick < MISS_GRACE_TICKS; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
      expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    }
    expect(game.getStatus()).toBe('playing');
  });

  it('a second miss occurs after the grace period elapses if the contact still persists', () => {
    const game = makePinnedContactGame();

    game.update({ dx: 0, dy: 0, drawHeld: false }); // miss #1
    expect(game.getLives()).toBe(INITIAL_LIVES - 1);

    for (let tick = 0; tick < MISS_GRACE_TICKS; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false }); // grace: no lives lost
    }
    expect(game.getLives()).toBe(INITIAL_LIVES - 1);

    // First tick after the grace period, contact ongoing -> miss #2.
    game.update({ dx: 0, dy: 0, drawHeld: false });
    expect(game.getLives()).toBe(INITIAL_LIVES - 2);
    expect(game.getStatus()).toBe('playing');
  });
});

describe('Game — Igniter lifecycle (M3, docs/plan.md §3.2/§3.4 (3)/§3.5)', () => {
  it('spawns after sustained stillness mid-line (disabling retract), and a catch-up costs a life and restores retract', () => {
    const field = new Field(10, 5);
    // Vertical heading pins the Wisp's x at 8, well clear of the x=7 line
    // being drawn (see the stageclear test above for the same setup).
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1) LINE; a 1-cell line
    expect(game.getMarker().isDrawing()).toBe(true);
    expect(game.getIgniter()).toBeNull();

    for (let tick = 0; tick < IGNITER_SPAWN_STILL_TICKS; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }

    expect(game.getIgniter()).not.toBeNull();
    expect(game.getIgniterPosition()).toEqual({ x: 7, y: 1 });
    expect(game.getLives()).toBe(INITIAL_LIVES);

    // Retract is disabled once the Igniter has spawned (docs/plan.md §3.2).
    const retractAttempt = game.getMarker().tryMove(field, 0, -1, false);
    expect(retractAttempt.moved).toBe(false);
    expect(retractAttempt.retracted).toBe(false);
    expect(game.getMarker().getPosition()).toEqual({ x: 7, y: 1 });

    // One more tick of stillness: the Igniter (already at index 0, equal to
    // this 1-cell line's max index) catches up immediately -> a miss.
    game.update({ dx: 0, dy: 0, drawHeld: false });

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.getIgniter()).toBeNull();
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.getMarker().getPosition()).toEqual({ x: 7, y: 0 });
    expect(field.get({ x: 7, y: 1 })).toBe(UNCLAIMED);

    // Retract capability is restored now that the Igniter is gone.
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1) LINE again
    const retractAgain = game.getMarker().tryMove(field, 0, -1, false);
    expect(retractAgain.retracted).toBe(true);
  });

  it('despawns the Igniter and re-enables retract once the area is claimed', () => {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1)

    for (let tick = 0; tick < IGNITER_SPAWN_STILL_TICKS; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }
    expect(game.getIgniter()).not.toBeNull();

    // Resume drawing all the way to the border to close the line before the
    // (already-caught-up) Igniter gets another tick to register a miss.
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,2)
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,3)
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,4) BORDER: closes

    expect(game.getStatus()).toBe('stageclear');
    expect(game.getIgniter()).toBeNull();
    expect(game.getLives()).toBe(INITIAL_LIVES);
  });
});
