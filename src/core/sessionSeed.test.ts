// New coverage for docs/plans/2026-08-11-daily-seed-time-attack request task
// 2 (`SessionOptions.seed` + the playing-only tick timer). Deliberately a
// separate file from session.test.ts (not an edit to it) — the request's
// completion criteria require every pre-existing unit test file to stay
// byte-for-byte unchanged.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './session';
import { Game } from './game';
import { Field } from './field';
import { Wisp } from './enemy';
import { MISS_GRACE_TICKS } from '../config';

// A field width chosen so that session.ts's buildWisps() anti-exploit push
// (WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN = 15, config.ts) always overflows
// the following clamp: pushing the spawn-cluster center 15 cells away from
// the marker's own column (floor(width/2) = 15) lands at 0 or 30, and the
// clamp to [1, width-2] = [1, 28] pins it to exactly 1 or 28 either way —
// regardless of seed. That gives every test below a *known*, wide,
// consistently Wisp-free majority on one side of the field to safely claim
// via a single straight vertical cut, without needing to special-case a
// particular seed's raw roll.
const SEED_TEST_FIELD_WIDTH = 30;
const SEED_TEST_FIELD_HEIGHT = 12;
const SEED_TEST_MARKER_COLUMN = Math.floor(SEED_TEST_FIELD_WIDTH / 2); // 15

/**
 * Walks the marker along the top border row (y=0) from wherever it
 * currently is to `targetX`, one cell per tick, without drawing. Always
 * collision-safe regardless of Wisp position (collision.ts: a confirmed
 * BORDER cell is never a hit) — see the E2E smoke suite's own "walk along
 * the freely-walkable top border" comment for the same trick.
 */
function walkBorderTo(session: GameSession, targetX: number, maxTicks = 40): void {
  let ticks = 0;
  while (session.getGame().getMarker().getPosition().x !== targetX) {
    const x = session.getGame().getMarker().getPosition().x;
    session.update({ dx: x < targetX ? 1 : -1, dy: 0, drawHeld: false, confirm: false });
    ticks++;
    if (ticks > maxTicks) {
      throw new Error('walkBorderTo: did not converge — test fixture geometry is wrong');
    }
  }
}

/**
 * Burns `steps` extra, safe (border-only, net-zero-displacement) ticks —
 * used to vary a run's total tick count without altering its eventual path,
 * so two runs that reach the same outcome via a different number of ticks
 * can be compared.
 */
function wanderOnBorder(session: GameSession, steps: number): void {
  for (let i = 0; i < steps; i++) {
    session.update({ dx: 1, dy: 0, drawHeld: false, confirm: false });
  }
  for (let i = 0; i < steps; i++) {
    session.update({ dx: -1, dy: 0, drawHeld: false, confirm: false });
  }
}

/** Draws a straight vertical line from the top border down to the bottom border, until the line closes (or the stage otherwise ends). */
function drawVerticalLineToClose(session: GameSession, maxTicks = 40): void {
  let ticks = 0;
  while (session.getStatus() === 'playing') {
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
    ticks++;
    if (ticks > maxTicks) {
      throw new Error('drawVerticalLineToClose: did not converge — test fixture geometry is wrong');
    }
  }
}

/**
 * Clears stage 1 of a freshly-constructed seeded session (field size =
 * SEED_TEST_FIELD_WIDTH/HEIGHT) via a single straight vertical cut, chosen
 * — from the real, seed-derived Wisp spawn read immediately at construction
 * (before any tick lets it drift) — to trap the Wisp in a small sliver on
 * one side while claiming most of the field (>=65% occupancy) on the other;
 * see SEED_TEST_FIELD_WIDTH's comment for why the spawn's side is knowable
 * ahead of time. `extraWanderTicks` burns that many extra safe ticks on the
 * border right after Title -> Playing (see wanderOnBorder) — kept small
 * (a handful of ticks) so the Wisp's extra drift can't plausibly cross the
 * fixed cut before it closes — so two calls with different values reach
 * 'stageclear' after a different number of total ticks while drawing the
 * exact same final shape.
 */
function clearStage1WithVariableDuration(session: GameSession, extraWanderTicks: number): void {
  // Read at construction time, before any tick has let the Wisp drift, so
  // both a 0-wander and an N-wander call agree on the same target cut.
  const wispSpawnX = session.getGame().getWisps()[0].getPosition().x;
  const targetX = wispSpawnX < SEED_TEST_MARKER_COLUMN ? 9 : SEED_TEST_FIELD_WIDTH - 10; // 9 or 20: margin from the pinned spawn edge (1 or 28)

  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing
  if (extraWanderTicks > 0) {
    wanderOnBorder(session, extraWanderTicks);
  }
  walkBorderTo(session, targetX);
  drawVerticalLineToClose(session);
}

describe('GameSession — seeded determinism (docs/plans/2026-08-11-daily-seed-time-attack request task 2)', () => {
  it('produces an identical stage-1 Wisp spawn for two independently-constructed sessions with the same seed', () => {
    const a = new GameSession({ seed: 20260811, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    const b = new GameSession({ seed: 20260811, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    expect(a.getGame().getWisps().map((w) => w.getPosition())).toEqual(
      b.getGame().getWisps().map((w) => w.getPosition())
    );
  });

  it('produces a different stage-1 Wisp spawn for a different seed', () => {
    const a = new GameSession({ seed: 1, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    const b = new GameSession({ seed: 2, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    expect(a.getGame().getWisps()[0].getPosition()).not.toEqual(b.getGame().getWisps()[0].getPosition());
  });

  it('prioritizes an explicit seed over the rng test hook when both are supplied', () => {
    const seeded = new GameSession({ seed: 777, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    const seededWithIgnoredRng = new GameSession({
      seed: 777,
      rng: () => 0.999999, // if this ever won out over `seed`, the spawn below would differ
      fieldWidth: SEED_TEST_FIELD_WIDTH,
      fieldHeight: SEED_TEST_FIELD_HEIGHT,
    });
    expect(seededWithIgnoredRng.getGame().getWisps()[0].getPosition()).toEqual(
      seeded.getGame().getWisps()[0].getPosition()
    );
  });

  it('replays byte-identically for the same seed + the same input sequence, N ticks in', () => {
    const inputs: SessionInput[] = [
      { dx: 0, dy: 0, drawHeld: false, confirm: true },
      { dx: -1, dy: 0, drawHeld: false, confirm: false },
      { dx: -1, dy: 0, drawHeld: false, confirm: false },
      { dx: -1, dy: 0, drawHeld: false, confirm: false },
      { dx: 0, dy: 1, drawHeld: true, confirm: false },
      { dx: 0, dy: 1, drawHeld: true, confirm: false },
      { dx: 0, dy: 1, drawHeld: true, confirm: false },
      { dx: 1, dy: 0, drawHeld: true, slow: true, confirm: false },
      { dx: 1, dy: 0, drawHeld: true, slow: true, confirm: false },
      { dx: 0, dy: 0, drawHeld: false, confirm: false },
    ];

    function run() {
      const session = new GameSession({ seed: 42, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
      for (const input of inputs) {
        session.update(input);
      }
      return {
        score: session.getScore(),
        lives: session.getLives(),
        stage: session.getStage(),
        status: session.getStatus(),
        marker: session.getGame().getMarker().getPosition(),
        wisps: session.getGame().getWisps().map((w) => w.getPosition()),
        occupancy: session.getGame().getOccupancy(),
        stageTicks: session.getStageTicks(),
        totalTicks: session.getTotalTicks(),
      };
    }

    expect(run()).toEqual(run());
  });
});

describe('GameSession — per-stage sub-seed invariance (docs/plans/2026-08-11-daily-seed-time-attack request task 2)', () => {
  it("stage 2's initial Wisp spawn is identical regardless of how many ticks stage 1 took to clear", () => {
    const seed = 555;

    const fast = new GameSession({ seed, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    clearStage1WithVariableDuration(fast, 0);
    expect(fast.getStatus()).toBe('stageclear');
    const fastStage1Ticks = fast.getStageTicks();

    const slow = new GameSession({ seed, fieldWidth: SEED_TEST_FIELD_WIDTH, fieldHeight: SEED_TEST_FIELD_HEIGHT });
    clearStage1WithVariableDuration(slow, 2);
    expect(slow.getStatus()).toBe('stageclear');
    const slowStage1Ticks = slow.getStageTicks();

    // Sanity: the two runs actually took a different number of ticks to
    // clear stage 1 — otherwise the equality check below wouldn't prove
    // anything about sub-seed independence.
    expect(slowStage1Ticks).toBeGreaterThan(fastStage1Ticks);

    fast.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> stage 2
    slow.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> stage 2
    expect(fast.getStage()).toBe(2);
    expect(slow.getStage()).toBe(2);

    expect(slow.getGame().getWisps().map((w) => w.getPosition())).toEqual(
      fast.getGame().getWisps().map((w) => w.getPosition())
    );
  });
});

describe('GameSession — playing-only tick timer (docs/plans/2026-08-11-daily-seed-time-attack request task 2)', () => {
  type Carry = { score: number; lives: number; multiplier: number };

  // Mirrors session.test.ts's own stageClearGame/missGame fixtures (kept
  // local rather than imported — that file stays unmodified per the
  // request's completion criteria).
  function clearableGame(_stage: number, carry: Carry): Game {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    return new Game(field, { x: 7, y: 0 }, wisp, undefined, {
      score: carry.score,
      lives: carry.lives,
      multiplier: carry.multiplier,
    });
  }

  function clearClearableGame(session: GameSession): void {
    for (let tick = 0; tick < 4; tick++) {
      session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
    }
  }

  function missGame(_stage: number, carry: Carry): Game {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
    return new Game(field, { x: 2, y: 0 }, wisp, undefined, {
      score: carry.score,
      lives: carry.lives,
      multiplier: carry.multiplier,
    });
  }

  function driveToGameOver(session: GameSession): void {
    while (session.getStatus() === 'playing') {
      session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false }); // steps onto the Wisp's line cell -> miss
      for (let tick = 0; tick < MISS_GRACE_TICKS && session.getStatus() === 'playing'; tick++) {
        session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
      }
    }
  }

  it('does not count ticks while on the Title screen', () => {
    const session = new GameSession({ gameFactory: clearableGame });
    session.update({ dx: 1, dy: 0, drawHeld: false, confirm: false });
    session.update({ dx: 0, dy: 1, drawHeld: false, confirm: false });
    expect(session.getStageTicks()).toBe(0);
    expect(session.getTotalTicks()).toBe(0);
  });

  it('counts exactly one tick per update() while playing, for both the per-stage and run-total counters', () => {
    const session = new GameSession({ gameFactory: clearableGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing: this tick itself doesn't count
    expect(session.getStageTicks()).toBe(0);

    for (let i = 0; i < 5; i++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    }
    expect(session.getStageTicks()).toBe(5);
    expect(session.getTotalTicks()).toBe(5);
  });

  it('keeps counting through the post-miss grace period (the stage stays "playing" throughout)', () => {
    const session = new GameSession({ gameFactory: missGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false }); // steps onto the Wisp -> miss, grace starts
    expect(session.getStatus()).toBe('playing'); // a miss with lives remaining stays 'playing'
    const ticksAfterMiss = session.getStageTicks();

    for (let i = 0; i < 10; i++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    }
    expect(session.getStageTicks()).toBe(ticksAfterMiss + 10);
  });

  it('freezes both counters once the stage leaves "playing" (stageclear); stageTicks resets on the next stage while totalTicks keeps accumulating', () => {
    const session = new GameSession({ gameFactory: clearableGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing

    for (let i = 0; i < 3; i++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false }); // 3 idle ticks
    }
    clearClearableGame(session); // 4 more ticks, ends in 'stageclear'
    expect(session.getStatus()).toBe('stageclear');
    expect(session.getStageTicks()).toBe(7);
    expect(session.getTotalTicks()).toBe(7);

    // Frozen while sitting on the StageClear screen.
    for (let i = 0; i < 5; i++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    }
    expect(session.getStageTicks()).toBe(7);
    expect(session.getTotalTicks()).toBe(7);

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> stage 2, playing
    expect(session.getStage()).toBe(2);
    expect(session.getStageTicks()).toBe(0); // fresh stage
    expect(session.getTotalTicks()).toBe(7); // run total carries over

    for (let i = 0; i < 4; i++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    }
    expect(session.getStageTicks()).toBe(4);
    expect(session.getTotalTicks()).toBe(11);
  });

  it('resets both counters to 0 on a brand-new run (GameOver -> Title -> Playing)', () => {
    const session = new GameSession({ gameFactory: missGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing
    driveToGameOver(session);
    expect(session.getStatus()).toBe('gameover');
    expect(session.getTotalTicks()).toBeGreaterThan(0);

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // GameOver -> Title (resetToFreshRun)
    expect(session.getStatus()).toBe('title');
    expect(session.getStageTicks()).toBe(0);
    expect(session.getTotalTicks()).toBe(0);

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing again
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    expect(session.getStageTicks()).toBe(1);
    expect(session.getTotalTicks()).toBe(1);
  });
});
