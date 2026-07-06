import { describe, it, expect } from 'vitest';
import { Field, CLAIMED_FAST, CLAIMED_SLOW, LINE, UNCLAIMED } from './field';
import { parseField } from './fieldFixture';
import { Game, GameInput } from './game';
import { Wisp } from './enemy';
import { Ember } from './patrol';
import {
  INITIAL_LIVES,
  MISS_GRACE_TICKS,
  MARKER_MOVE_TICKS_SLOW,
  IGNITER_SPAWN_STILL_TICKS,
  DEFAULT_REQUIRED_OCCUPANCY,
  EMBER_MOVE_TICKS,
  EMBER_BRANCH_CHASE_PROBABILITY,
  EMBER_SPAWN_INTERVAL_SEC,
} from '../config';

describe('Game — event queue (M5, docs/plan.md §3.8/§9.9)', () => {
  it('starts with no events queued', () => {
    const game = new Game(new Field(6, 5), { x: 2, y: 0 });
    expect(game.drainEvents()).toEqual([]);
  });

  it('queues area-claimed (and not stage-clear) for a claim that does not reach the required occupancy', () => {
    const field = new Field(10, 5); // interior x=1..8, y=1..3 -> 24 UNCLAIMED cells
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp, undefined, { requiredOccupancy: 0.9 });

    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true }); // claims 18/24, short of the 90% requirement

    expect(game.getStatus()).toBe('playing');
    expect(game.drainEvents()).toEqual(['area-claimed']);
    // Already drained -> nothing left to see on a second call.
    expect(game.drainEvents()).toEqual([]);
  });

  it('queues area-claimed followed by stage-clear when the claim reaches the required occupancy', () => {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });

    expect(game.getStatus()).toBe('stageclear');
    expect(game.drainEvents()).toEqual(['area-claimed', 'stage-clear']);
  });

  it('queues area-claimed followed by split-clear when a claim splits the 2 Wisps apart', () => {
    const field = new Field(10, 5);
    const leftWisp = new Wisp({ x: 2, y: 2 }, () => 0.5, Math.PI / 2);
    const rightWisp = new Wisp({ x: 7, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 5, y: 0 }, undefined, undefined, { wisps: [leftWisp, rightWisp] });

    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });

    expect(game.getStatus()).toBe('stageclear');
    expect(game.getLastClearWasSplit()).toBe(true);
    expect(game.drainEvents()).toEqual(['area-claimed', 'split-clear']);
  });

  it('queues miss whenever a Wisp/Ember/Igniter contact triggers handleMiss', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // steps onto the Wisp's line cell -> miss

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.drainEvents()).toEqual(['miss']);
  });

  it('queues ember-spawned each time a fresh pair of Embers appears', () => {
    const field = new Field(10, 6);
    const wisp = new Wisp({ x: 5, y: 3 }, () => 0.5, 0);
    const game = new Game(field, { x: 5, y: 0 }, wisp, undefined, { emberSpawnIntervalTicks: 3 });

    game.update({ dx: 0, dy: 0, drawHeld: false }); // cooldown 3 -> 2
    expect(game.drainEvents()).toEqual([]);
    game.update({ dx: 0, dy: 0, drawHeld: false }); // -> 1
    game.update({ dx: 0, dy: 0, drawHeld: false }); // -> 0, next tick spawns
    game.update({ dx: 0, dy: 0, drawHeld: false }); // spawns this tick

    expect(game.getEmbers().length).toBe(2);
    expect(game.drainEvents()).toEqual(['ember-spawned']);
  });

  it('queues igniter-spawned once still long enough, then igniter-approaching as it advances', () => {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1) LINE; a 1-cell line
    game.drainEvents(); // clear the area-claimed-unrelated noise (none expected, but keep the assertion below focused)

    for (let tick = 0; tick < IGNITER_SPAWN_STILL_TICKS - 1; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }
    expect(game.getIgniter()).toBeNull();
    expect(game.drainEvents()).toEqual([]);

    game.update({ dx: 0, dy: 0, drawHeld: false }); // crosses the still-ticks threshold -> spawns
    expect(game.getIgniter()).not.toBeNull();
    expect(game.drainEvents()).toEqual(['igniter-spawned']);
  });

  it('does not emit igniter-approaching on ticks where the Igniter is still on cooldown', () => {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1) LINE

    for (let tick = 0; tick < IGNITER_SPAWN_STILL_TICKS; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }
    game.drainEvents(); // consume the igniter-spawned event from above

    // With a 1-cell line, the Igniter's maxIndex is already 0 (its spawn
    // index) — it never has room to advance, so no further
    // igniter-approaching events are queued regardless of how long stillness
    // continues (a catch-up/miss happens instead, tested elsewhere).
    game.update({ dx: 0, dy: 0, drawHeld: false });
    expect(game.drainEvents()).toEqual(['miss']);
  });
});

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

describe('Game — 2 Wisps and split-triggered stage clear (M4, docs/plan.md §4.2/§3.6/§12.7)', () => {
  it('clears the stage instantly via a split, even when occupancy is well under the required threshold', () => {
    const field = new Field(10, 5); // interior x=1..8, y=1..3 -> 24 UNCLAIMED cells
    const leftWisp = new Wisp({ x: 2, y: 2 }, () => 0.5, Math.PI / 2); // vertical heading, x pinned at 2
    const rightWisp = new Wisp({ x: 7, y: 2 }, () => 0.5, Math.PI / 2); // vertical heading, x pinned at 7
    const game = new Game(field, { x: 5, y: 0 }, undefined, undefined, { wisps: [leftWisp, rightWisp] });

    expect(game.getWisps()).toHaveLength(2);

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (5,1) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (5,2) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (5,3) LINE
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (5,4) BORDER: closes, splitting the two Wisps apart

    expect(game.getStatus()).toBe('stageclear');
    expect(game.getLastClearWasSplit()).toBe(true);
    // Well under DEFAULT_REQUIRED_OCCUPANCY (0.65) — the split alone cleared it.
    expect(game.getOccupancy()).toBeLessThan(DEFAULT_REQUIRED_OCCUPANCY);
  });

  it('does not report a split-clear for an ordinary (non-split) 2-Wisp area confirmation', () => {
    const field = new Field(10, 5); // interior x=1..8, y=1..3 -> 24 UNCLAIMED cells
    const wispA = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2); // vertical heading, x pinned at 8
    const wispB = new Wisp({ x: 8, y: 3 }, () => 0.5, Math.PI / 2); // same (right) side as wispA
    const game = new Game(field, { x: 7, y: 0 }, undefined, undefined, { wisps: [wispA, wispB] });

    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,1)
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,2)
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,3)
    game.update({ dx: 0, dy: 1, drawHeld: true }); // -> (7,4) BORDER: closes, claiming the 18-cell left side

    expect(game.getOccupancy()).toBeCloseTo(18 / 24);
    expect(game.getLastClearWasSplit()).toBe(false);
    expect(game.getStatus()).toBe('stageclear'); // cleared via occupancy, not a split
  });

  it('honors a custom requiredOccupancy (docs/plan.md §12.7 curve escalates toward 90% by stage 10)', () => {
    const field = new Field(10, 5); // 24 UNCLAIMED cells
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp, undefined, { requiredOccupancy: 0.9 });

    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true });
    game.update({ dx: 0, dy: 1, drawHeld: true }); // claims 18/24 = 75%, short of the 90% requirement

    expect(game.getOccupancy()).toBeCloseTo(18 / 24);
    expect(game.getStatus()).toBe('playing'); // not cleared — requirement wasn't met
  });

  it('carries a starting score and lives via GameOptions (docs/plan.md §6 M4 stage-to-stage carryover)', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 3, y: 2 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp, undefined, { score: 1234, lives: 2 });

    expect(game.getScore()).toBe(1234);
    expect(game.getLives()).toBe(2);
  });
});

describe('Game — debug overrides (docs/plan.md §6 M10 / §12.4)', () => {
  function freshGame(): Game {
    return new Game(new Field(20, 20), { x: 10, y: 0 });
  }

  it('spawns/despawns Wisps immediately to match an overridden wispCount', () => {
    const game = freshGame();
    expect(game.getWisps().length).toBe(1); // stage default: a single Wisp

    game.applyDebugOverrides({ wispCount: 4 });
    expect(game.getWisps().length).toBe(4);

    game.applyDebugOverrides({ wispCount: 0 });
    expect(game.getWisps().length).toBe(0);
  });

  it('spawns/despawns Embers immediately to match an overridden emberCount', () => {
    const game = freshGame();
    expect(game.getEmbers().length).toBe(0); // none yet — the spawn timer hasn't elapsed

    game.applyDebugOverrides({ emberCount: 3 });
    expect(game.getEmbers().length).toBe(3);

    game.applyDebugOverrides({ emberCount: 6 });
    expect(game.getEmbers().length).toBe(6);

    game.applyDebugOverrides({ emberCount: 1 });
    expect(game.getEmbers().length).toBe(1);
  });

  it('applies wispSpeedMultiplier to every current Wisp, and to Wisps spawned afterward', () => {
    const game = freshGame();
    game.applyDebugOverrides({ wispCount: 2, wispSpeedMultiplier: 2.5 });

    for (const wisp of game.getWisps()) {
      expect(wisp.getSpeedMultiplier()).toBe(2.5);
    }
    expect(game.getEffectiveDebugParams().wispSpeedMultiplier).toBe(2.5);

    game.applyDebugOverrides({ wispCount: 3 }); // a 3rd Wisp, added after the speed override
    expect(game.getWisps()[2].getSpeedMultiplier()).toBe(2.5);
  });

  it('applies emberMoveTicks and emberBranchChaseProbability to every current Ember, and to Embers spawned afterward', () => {
    const game = freshGame();
    game.applyDebugOverrides({ emberCount: 2, emberMoveTicks: 7, emberBranchChaseProbability: 0.15 });

    for (const ember of game.getEmbers()) {
      expect(ember.getMoveTicks()).toBe(7);
      expect(ember.getBranchChaseProbability()).toBe(0.15);
    }

    game.applyDebugOverrides({ emberCount: 3 }); // a 3rd Ember, added after the tuning override
    expect(game.getEmbers()[2].getMoveTicks()).toBe(7);
    expect(game.getEmbers()[2].getBranchChaseProbability()).toBe(0.15);
  });

  it('reflects an emberSpawnIntervalSec override in the effective params', () => {
    const game = freshGame();
    game.applyDebugOverrides({ emberSpawnIntervalSec: 5 });
    expect(game.getEffectiveDebugParams().emberSpawnIntervalSec).toBe(5);
  });

  it('applies a requiredOccupancy override immediately', () => {
    const game = freshGame();
    expect(game.getRequiredOccupancy()).toBe(DEFAULT_REQUIRED_OCCUPANCY);

    game.applyDebugOverrides({ requiredOccupancy: 0.2 });
    expect(game.getRequiredOccupancy()).toBe(0.2);
    expect(game.getEffectiveDebugParams().requiredOccupancy).toBe(0.2);
  });

  it('reports hasActiveDebugOverrides only while at least one override is active', () => {
    const game = freshGame();
    expect(game.hasActiveDebugOverrides()).toBe(false);

    game.applyDebugOverrides({ wispCount: 2 });
    expect(game.hasActiveDebugOverrides()).toBe(true);

    game.resetDebugOverrides();
    expect(game.hasActiveDebugOverrides()).toBe(false);
  });

  it("resetDebugOverrides restores every knob to this stage's own defaults", () => {
    const field = new Field(20, 20);
    const wisp = new Wisp({ x: 10, y: 10 }, () => 0.5, 0, 1.3); // this stage's own (non-default) speed multiplier
    const game = new Game(field, { x: 10, y: 0 }, wisp, undefined, { requiredOccupancy: 0.7 });

    game.applyDebugOverrides({
      wispCount: 3,
      wispSpeedMultiplier: 2.9,
      emberCount: 4,
      emberMoveTicks: 9,
      emberSpawnIntervalSec: 3,
      emberBranchChaseProbability: 0.9,
      requiredOccupancy: 0.15,
    });
    expect(game.getWisps().length).toBe(3);
    expect(game.getEmbers().length).toBe(4);

    game.resetDebugOverrides();

    expect(game.getWisps().length).toBe(1);
    expect(game.getWisps()[0].getSpeedMultiplier()).toBe(1.3);
    expect(game.getEmbers().length).toBe(0);
    expect(game.getRequiredOccupancy()).toBe(0.7);
    expect(game.getEffectiveDebugParams().emberMoveTicks).toBe(EMBER_MOVE_TICKS);
    expect(game.getEffectiveDebugParams().emberBranchChaseProbability).toBe(EMBER_BRANCH_CHASE_PROBABILITY);
    expect(game.getEffectiveDebugParams().emberSpawnIntervalSec).toBeCloseTo(EMBER_SPAWN_INTERVAL_SEC);
    expect(game.hasActiveDebugOverrides()).toBe(false);
  });
});

describe('Game — Ember despawn on claim (docs/plan.md §6 M11 / §12.6)', () => {
  // A pre-existing interior wall at x=3 (with an Ember on it, `trappedEmber`)
  // sits between an already-claimed left chamber (x=1-2) and a small
  // still-UNCLAIMED gap (x=4-5, no Wisp) that the marker's new vertical line
  // at x=5 is about to close off. Once that gap is claimed, x=3's wall loses
  // its last UNCLAIMED neighbor and gets pruned by claimArea's
  // pruneDeadBorders — exactly the "footing vanishes out from under a
  // stationary Ember" bug (docs/plan.md §12.6). A second wall at x=6 (with
  // `survivingEmber`) keeps a genuine UNCLAIMED neighbor (x=7, where the
  // Wisp lives) even after the same claim, so it must NOT be pruned/despawned
  // — the control case for "still a valid/active border".
  //
  //   ###########
  //   #ff#..#...#   <- y=1
  //   #ff#..#...#   <- y=2 (trappedEmber@(3,2), survivingEmber@(6,2), Wisp@(8,2))
  //   #ff#..#...#   <- y=3
  //   ###########
  //
  // Marker starts at (5,0) and is walked straight down to (5,4) — 4 ticks,
  // matching this file's other "close a straight vertical line" tests —
  // closing a new line at x=5 that claims the x=4 gap and leaves x=6-9
  // UNCLAIMED (the Wisp's side).
  function buildEmberTrapGame(): Game {
    const field = parseField(`
      ###########
      #ff#..#...#
      #ff#..#...#
      #ff#..#...#
      ###########
    `).field;

    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, 0);
    // rng () => 1 + branchChaseProbability 0 keeps both Embers' first (and
    // only, given moveTicks=100) move fully deterministic: "maintain
    // heading" always wins over the (never-rolled) chase branch. Each starts
    // heading "up" so its one guaranteed move (cooldown starts at 0) stays
    // on the same wall column, one cell up.
    const trappedEmber = new Ember({ x: 3, y: 2 }, { dx: 0, dy: -1 }, () => 1, 100, 0);
    const survivingEmber = new Ember({ x: 6, y: 2 }, { dx: 0, dy: -1 }, () => 1, 100, 0);

    return new Game(field, { x: 5, y: 0 }, wisp, undefined, {
      embers: [trappedEmber, survivingEmber],
    });
  }

  it('despawns an Ember whose BORDER footing gets embedded in claimed area by the claim', () => {
    const game = buildEmberTrapGame();

    for (let tick = 0; tick < 4; tick++) {
      game.update({ dx: 0, dy: 1, drawHeld: true });
    }

    // trappedEmber (wall x=3, now fully surrounded by claimed cells) is gone...
    expect(game.getEmberPositions()).not.toContainEqual({ x: 3, y: 1 });
    expect(game.getEmbers().length).toBe(1);
  });

  it('keeps an Ember alive on a BORDER line that still borders UNCLAIMED play area after the claim', () => {
    const game = buildEmberTrapGame();

    for (let tick = 0; tick < 4; tick++) {
      game.update({ dx: 0, dy: 1, drawHeld: true });
    }

    // ...but survivingEmber (wall x=6, still adjacent to the Wisp's UNCLAIMED
    // side at x=7) is still there, untouched.
    expect(game.getEmberPositions()).toContainEqual({ x: 6, y: 1 });
    expect(game.getEmbers().length).toBe(1);
  });

  it('queues an ember-despawned event and its despawn position, each independently drainable', () => {
    const game = buildEmberTrapGame();

    for (let tick = 0; tick < 4; tick++) {
      game.update({ dx: 0, dy: 1, drawHeld: true });
    }

    expect(game.drainEvents()).toContain('ember-despawned');
    expect(game.drainDespawnedEmberPositions()).toEqual([{ x: 3, y: 1 }]);
    // Already drained -> nothing left on a second call (docs/plan.md §3.8's
    // drain-once contract, same as drainEvents()).
    expect(game.drainDespawnedEmberPositions()).toEqual([]);
  });

  it('does not immediately respawn a naturally-despawned Ember even while a debug emberCount override is active', () => {
    // docs/plan.md §6 M11 point 5 / §12.6 point 5: applyDebugOverrides() is
    // only ever invoked by the debug panel when a slider actually changes —
    // Game never re-reconciles emberCount on its own each tick — so a trapped
    // Ember despawning mid-play should NOT be silently topped back up until
    // the panel is touched again (or the periodic spawn naturally adds a
    // fresh pair).
    const game = buildEmberTrapGame();
    // reconcileDebugOverrides() re-applies *every* knob (not just the one
    // just touched) to its currently-effective value, falling back to this
    // stage's base for anything not explicitly overridden (see
    // Game.reconcileDebugOverrides) — so emberMoveTicks/branchChaseProbability
    // must be pinned back to this fixture's deterministic values here too,
    // or the override call itself would silently undo buildEmberTrapGame()'s
    // moveTicks=100 setup and let both Embers wander mid-test.
    game.applyDebugOverrides({ emberCount: 2, emberMoveTicks: 100, emberBranchChaseProbability: 0 });

    for (let tick = 0; tick < 4; tick++) {
      game.update({ dx: 0, dy: 1, drawHeld: true });
    }

    // One Ember was trapped and despawned; nothing silently replaced it even
    // though an emberCount override of 2 is still active.
    expect(game.getEmbers().length).toBe(1);
    expect(game.getEffectiveDebugParams().emberCount).toBe(1);
  });
});

describe('Game — Ember concurrency cap (docs/plan.md §6 M12 / §12.7)', () => {
  it('skips spawning a fresh Ember pair once at maxConcurrentEmbers, but keeps resetting the cooldown to retry next interval', () => {
    const field = new Field(10, 6);
    const wisp = new Wisp({ x: 5, y: 3 }, () => 0.5, 0);
    // moveTicks: 1000 keeps both stationary for the handful of ticks this
    // test runs — their exact behavior isn't what's under test here.
    const existingA = new Ember({ x: 0, y: 0 }, { dx: 1, dy: 0 }, () => 1, 1000, 0);
    const existingB = new Ember({ x: 9, y: 0 }, { dx: -1, dy: 0 }, () => 1, 1000, 0);
    const game = new Game(field, { x: 5, y: 0 }, wisp, undefined, {
      embers: [existingA, existingB],
      emberSpawnIntervalTicks: 1,
      maxConcurrentEmbers: 2, // already at the cap with these 2 preset Embers
    });

    game.update({ dx: 0, dy: 0, drawHeld: false }); // cooldown 1 -> 0 (no spawn attempt yet)
    expect(game.getEmbers().length).toBe(2);

    game.update({ dx: 0, dy: 0, drawHeld: false }); // cooldown 0 -> spawn attempted, but at the cap -> skipped
    expect(game.getEmbers().length).toBe(2);
    expect(game.drainEvents()).not.toContain('ember-spawned');
  });

  it('tops back up on the next spawn interval once a trapped Ember despawns below the cap (docs/plan.md §6 M11 interplay)', () => {
    // Same interior-wall fixture as the M11 despawn describe block above:
    //   ###########
    //   #ff#..#...#   <- y=1
    //   #ff#..#...#   <- y=2 (trappedEmber@(3,2), survivingEmber@(6,2), Wisp@(8,2))
    //   #ff#..#...#   <- y=3
    //   ###########
    // Marker walks straight down from (5,0), closing a line at x=5 on tick 4
    // that prunes the x=3 wall (trappedEmber's footing) into claimed area,
    // despawning it and dropping the live Ember count to 1 — under this
    // test's maxConcurrentEmbers of 2.
    const field = parseField(`
      ###########
      #ff#..#...#
      #ff#..#...#
      #ff#..#...#
      ###########
    `).field;

    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, 0);
    const trappedEmber = new Ember({ x: 3, y: 2 }, { dx: 0, dy: -1 }, () => 1, 100, 0);
    const survivingEmber = new Ember({ x: 6, y: 2 }, { dx: 0, dy: -1 }, () => 1, 100, 0);

    const game = new Game(field, { x: 5, y: 0 }, wisp, undefined, {
      embers: [trappedEmber, survivingEmber],
      emberSpawnIntervalTicks: 6,
      maxConcurrentEmbers: 2,
    });

    for (let tick = 0; tick < 4; tick++) {
      game.update({ dx: 0, dy: 1, drawHeld: true });
    }
    expect(game.getEmbers().length).toBe(1); // trappedEmber despawned; survivingEmber remains

    // Run out the spawn cooldown (6 ticks total elapsed across this test;
    // the first 4 already ticked it down to 2 while the line was drawn).
    for (let tick = 0; tick < 3; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }

    // Now below the cap (1 < 2) -> the periodic spawn tops back up.
    expect(game.getEmbers().length).toBe(2);
    expect(game.drainEvents()).toContain('ember-spawned');
  });
});
