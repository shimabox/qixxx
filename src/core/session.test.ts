import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { Game } from './game';
import { Field } from './field';
import { parseField } from './fieldFixture';
import { Wisp } from './enemy';
import { Ember } from './patrol';
import { INITIAL_LIVES, MISS_GRACE_TICKS, WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN } from '../config';
import { getStageConfig } from './stage';

type Carry = { score: number; lives: number; multiplier: number };

/**
 * A tiny, deterministic stage that clears via ordinary occupancy (not a
 * split) — a straight vertical line at x=7 in a 10x5 field (interior
 * x=1..8, y=1..3 -> 24 UNCLAIMED cells), claiming the 18-cell left region
 * with a single Wisp pinned at x=8 (mirrors game.test.ts's own "reaches
 * stageclear" fixture, docs/plan.md §3.3/§3.7).
 */
function stageClearGame(_stage: number, carry: Carry): Game {
  const field = new Field(10, 5);
  const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2); // vertical heading pins x at 8
  return new Game(field, { x: 7, y: 0 }, wisp, undefined, {
    score: carry.score,
    lives: carry.lives,
    multiplier: carry.multiplier,
  });
}

/** Draws the straight vertical line that closes/clears `stageClearGame` (4 ticks). */
function clearStageClearGame(session: GameSession): void {
  for (let tick = 0; tick < 4; tick++) {
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
  }
}

/**
 * A tiny, deterministic 2-Wisp stage that clears via a split — a straight
 * vertical line at x=5 in a 10x5 field, with one Wisp pinned on each side
 * (mirrors claim.test.ts's own split fixture, docs/plan.md §4.2).
 */
function splitGame(_stage: number, carry: Carry): Game {
  const field = new Field(10, 5);
  const leftWisp = new Wisp({ x: 2, y: 2 }, () => 0.5, Math.PI / 2);
  const rightWisp = new Wisp({ x: 7, y: 2 }, () => 0.5, Math.PI / 2);
  return new Game(field, { x: 5, y: 0 }, undefined, undefined, {
    wisps: [leftWisp, rightWisp],
    score: carry.score,
    lives: carry.lives,
    multiplier: carry.multiplier,
  });
}

/** Draws the straight vertical line that closes/splits `splitGame` (4 ticks). */
function clearSplitGame(session: GameSession): void {
  for (let tick = 0; tick < 4; tick++) {
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
  }
}

/**
 * A tiny, deterministic stage where the marker's very first step off the
 * border lands on the Wisp's own position — an immediate miss (mirrors
 * game.test.ts's own miss fixture, docs/plan.md §3.5).
 */
function missGame(_stage: number, carry: Carry): Game {
  const field = new Field(6, 5);
  const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
  return new Game(field, { x: 2, y: 0 }, wisp, undefined, {
    score: carry.score,
    lives: carry.lives,
    multiplier: carry.multiplier,
  });
}

/**
 * Drives `missGame` to gameover by deliberately missing over and over,
 * burning off the post-miss grace period between attempts (docs/plan.md
 * §3.5) so every deliberate miss actually costs a life — mirrors
 * game.test.ts's own "goes to gameover once lives reach zero" pattern.
 * Works regardless of how many lives the stage started with (respects
 * whatever `carry.lives` was actually passed in, unlike a factory that
 * hardcodes a life count).
 */
function driveToGameOver(session: GameSession): void {
  while (session.getStatus() === 'playing') {
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false }); // steps onto the Wisp's line cell -> miss
    for (let tick = 0; tick < MISS_GRACE_TICKS && session.getStatus() === 'playing'; tick++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    }
  }
}

describe('GameSession — Title/Playing/StageClear/GameOver state machine (M4, docs/plan.md §4.4/§6)', () => {
  it('starts on the Title screen and only starts Playing once confirm is pressed', () => {
    const session = new GameSession();
    expect(session.getStatus()).toBe('title');

    session.update({ dx: 1, dy: 0, drawHeld: false, confirm: false });
    expect(session.getStatus()).toBe('title'); // movement alone doesn't start the game

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    expect(session.getStatus()).toBe('playing');
    expect(session.getStage()).toBe(1);
  });

  it('carries score/lives/multiplier across a normal (non-split) stage clear, resetting occupancy for the new stage', () => {
    const session = new GameSession({ gameFactory: stageClearGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    clearStageClearGame(session);
    expect(session.getStatus()).toBe('stageclear');
    expect(session.getGame().getLastClearWasSplit()).toBe(false);
    const scoreAfterStage1 = session.getScore();
    expect(scoreAfterStage1).toBeGreaterThan(0);
    expect(session.getLives()).toBe(INITIAL_LIVES);
    expect(session.getMultiplier()).toBe(1); // no split -> unchanged

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // advance
    expect(session.getStatus()).toBe('playing');
    expect(session.getStage()).toBe(2);
    expect(session.getScore()).toBe(scoreAfterStage1); // carried over verbatim
    expect(session.getGame().getOccupancy()).toBe(0); // fresh field

    clearStageClearGame(session);
    expect(session.getStatus()).toBe('stageclear');
    expect(session.getScore()).toBeGreaterThan(scoreAfterStage1); // kept accumulating
    expect(session.getLives()).toBe(INITIAL_LIVES); // never missed
  });

  it('bumps the score multiplier by split-successes + 1 on each split-stage-clear', () => {
    const session = new GameSession({ gameFactory: splitGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    for (let expectedMultiplierAfter = 2; expectedMultiplierAfter <= 5; expectedMultiplierAfter++) {
      clearSplitGame(session);
      expect(session.getStatus()).toBe('stageclear');
      expect(session.getGame().getLastClearWasSplit()).toBe(true);

      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // advance
      expect(session.getMultiplier()).toBe(expectedMultiplierAfter);
    }
  });

  it('caps the split multiplier at 9x even after many consecutive splits', () => {
    const session = new GameSession({ gameFactory: splitGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    for (let i = 0; i < 12; i++) {
      clearSplitGame(session);
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    }

    expect(session.getMultiplier()).toBe(9);
  });

  it('resets the multiplier to 1x on any miss, even after a split streak had raised it', () => {
    const session = new GameSession({
      gameFactory: (stage, carry) => (stage === 1 ? splitGame(stage, carry) : missGame(stage, carry)),
    });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // stage 1, playing

    clearSplitGame(session); // splits -> multiplier becomes 2
    expect(session.getMultiplier()).toBe(2);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // advance to stage 2 (missGame), carrying multiplier 2

    const livesBefore = session.getLives();
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false }); // steps onto the Wisp's line cell -> miss

    expect(session.getLives()).toBe(livesBefore - 1);
    expect(session.getMultiplier()).toBe(1);
    expect(session.getStatus()).toBe('playing'); // still has lives left
  });

  it('goes to gameover once lives reach zero and tracks the high score', () => {
    const session = new GameSession({ gameFactory: missGame, highScore: 500 });
    expect(session.getHighScore()).toBe(500);

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    expect(session.getLives()).toBe(INITIAL_LIVES);

    driveToGameOver(session);

    expect(session.getStatus()).toBe('gameover');
    expect(session.getLives()).toBe(0);
    // This run scored 0, which never exceeded the seeded high score.
    expect(session.getHighScore()).toBe(500);
  });

  it('fully resets stage/lives/score/multiplier on GameOver -> Title', () => {
    const session = new GameSession({ gameFactory: missGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    driveToGameOver(session);
    expect(session.getStatus()).toBe('gameover');

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> Title

    expect(session.getStatus()).toBe('title');
    expect(session.getStage()).toBe(1);
    expect(session.getLives()).toBe(INITIAL_LIVES);
    expect(session.getScore()).toBe(0);
    expect(session.getMultiplier()).toBe(1);

    // And Title -> Playing afterward starts a genuinely fresh run.
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    expect(session.getStatus()).toBe('playing');
    expect(session.getLives()).toBe(INITIAL_LIVES);
  });

  it("raises the high score once this run's score exceeds the seeded value", () => {
    const session = new GameSession({ gameFactory: stageClearGame, highScore: 5 });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    clearStageClearGame(session);

    expect(session.getScore()).toBeGreaterThan(5);
    expect(session.getHighScore()).toBe(session.getScore());
  });
});

/**
 * A tiny, deterministic stage where a claim traps an Ember on a wall that
 * loses its last UNCLAIMED neighbor (mirrors game.test.ts's own Ember-trap
 * fixture, docs/plan.md §6 M11/§12.6): a pre-existing wall at x=3 (holding
 * `trappedEmber`) sits between an already-claimed chamber and a small gap the
 * marker's new vertical line at x=5 is about to close off.
 */
function emberTrapGame(_stage: number, carry: Carry): Game {
  const field = parseField(`
    ###########
    #ff#..#...#
    #ff#..#...#
    #ff#..#...#
    ###########
  `).field;
  const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, 0);
  const trappedEmber = new Ember({ x: 3, y: 2 }, { dx: 0, dy: -1 }, () => 1, 100, 0);
  return new Game(field, { x: 5, y: 0 }, wisp, undefined, {
    embers: [trappedEmber],
    score: carry.score,
    lives: carry.lives,
    multiplier: carry.multiplier,
  });
}

/** Draws the straight vertical line that closes/traps `emberTrapGame` (4 ticks). */
function clearEmberTrapGame(session: GameSession): void {
  for (let tick = 0; tick < 4; tick++) {
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
  }
}

describe('GameSession — event forwarding (M5, docs/plan.md §3.8/§9.9)', () => {
  it('forwards the current stage Game\'s events, draining them once', () => {
    const session = new GameSession({ gameFactory: stageClearGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    expect(session.drainEvents()).toEqual([]);

    clearStageClearGame(session);
    expect(session.getStatus()).toBe('stageclear');

    expect(session.drainEvents()).toEqual(['area-claimed', 'stage-clear']);
    // Already drained -> nothing left, even though the Game itself is still
    // sitting in 'stageclear'.
    expect(session.drainEvents()).toEqual([]);
  });

  it('forwards split-clear events distinctly from ordinary stage-clear events', () => {
    const session = new GameSession({ gameFactory: splitGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    clearSplitGame(session);
    expect(session.getStatus()).toBe('stageclear');
    expect(session.drainEvents()).toEqual(['area-claimed', 'split-clear']);
  });

  it('does not lose events across a stage transition that replaces the underlying Game', () => {
    const session = new GameSession({ gameFactory: stageClearGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    clearStageClearGame(session);
    session.drainEvents(); // consume stage 1's clear events

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // advance -> stage 2, a fresh Game instance
    expect(session.getStage()).toBe(2);

    clearStageClearGame(session);
    // Stage 2's own claim/clear events are still forwarded correctly even
    // though `this.game` was swapped out from under the queue in between.
    expect(session.drainEvents()).toEqual(['area-claimed', 'stage-clear']);
  });

  it('forwards a miss event the instant it happens', () => {
    const session = new GameSession({ gameFactory: missGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false }); // steps onto the Wisp's line cell -> miss

    expect(session.drainEvents()).toEqual(['miss']);
  });

  it('forwards an ember-despawned event and its despawn position (docs/plan.md §6 M11/§12.6)', () => {
    const session = new GameSession({ gameFactory: emberTrapGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    clearEmberTrapGame(session);

    expect(session.drainEvents()).toEqual(['ember-despawned', 'area-claimed']);
    expect(session.drainDespawnedEmberPositions()).toEqual([{ x: 3, y: 1 }]);
    // Already drained -> nothing left on a second call.
    expect(session.drainDespawnedEmberPositions()).toEqual([]);
  });
});

describe('GameSession — real stage progression difficulty (M4/M12, docs/plan.md §12.7)', () => {
  const FIELD_WIDTH = 100;
  const FIELD_HEIGHT = 6;

  /**
   * Lets the stage's single Wisp drift toward the left interior wall
   * (deterministic: rng=()=>0.5 gives a fixed, purely-leftward heading with
   * zero jitter — see enemy.ts), then walls off everything to its right
   * with a generous margin (comfortably beyond the up-to-WISP_HISTORY_LENGTH
   * -cell trail it's dragging along, docs/plan.md §3.4 — the trail itself is
   * a hazard, so the drawn line must clear it entirely, not just the head)
   * so the large remainder (>= 65% of the field) can be claimed with one
   * straight vertical line.
   */
  function clearByWallingOffTheWisp(session: GameSession): void {
    for (let tick = 0; tick < 400 && session.getGame().getWisps()[0].getPosition().x > 2; tick++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    }
    const cornered = session.getGame().getWisps()[0].getPosition().x;
    expect(cornered).toBeLessThanOrEqual(2);

    const wallColumn = cornered + 30;
    const marker = session.getGame().getMarker();
    while (marker.getPosition().x > wallColumn) {
      session.update({ dx: -1, dy: 0, drawHeld: false, confirm: false });
    }
    for (let tick = 0; tick < FIELD_HEIGHT - 1; tick++) {
      session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
    }
  }

  it('spawns wispCount == stage number (stage 2 already has 2 Wisps under the M12 curve), via the real (non-test-hook) per-stage builder', () => {
    // docs/plan.md §12.7 replaces the old "2 Wisps from stage 3" table with
    // "stage n = n Wisps" — stage 2 is now the first multi-Wisp stage, one
    // stage earlier than the pre-M12 curve this test used to exercise.
    const session = new GameSession({ fieldWidth: FIELD_WIDTH, fieldHeight: FIELD_HEIGHT, rng: () => 0.5 });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> stage 1, playing
    expect(session.getStage()).toBe(1);
    expect(session.getGame().getWisps().length).toBe(1);

    clearByWallingOffTheWisp(session);
    expect(session.getStatus()).toBe('stageclear');
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> stage 2
    expect(session.getStage()).toBe(2);
    expect(session.getGame().getWisps().length).toBe(2);
  });
});

describe('GameSession — randomized Wisp spawn cluster (anti center-line-split exploit, docs/plan.md)', () => {
  // Large enough that WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN always fits
  // comfortably inside the interior on either side of the marker's start
  // column, so the offset guarantee below is never just "best effort".
  const FIELD_WIDTH = 200;
  const FIELD_HEIGHT = 100;

  /**
   * Tiny deterministic PRNG (mulberry32), seeded per-call so each test can
   * cheaply explore many distinct, reproducible spawn rolls without relying
   * on Math.random. Contrast with the constant `() => 0.5` rng used
   * elsewhere in this file (which only ever exercises a single, fixed
   * spawn roll and is exactly why the tests below sweep many seeds
   * instead).
   */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function stage1WispsFor(rng: () => number) {
    const session = new GameSession({ fieldWidth: FIELD_WIDTH, fieldHeight: FIELD_HEIGHT, rng });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // -> stage 1, playing
    return session.getGame().getWisps();
  }

  it('spawns every Wisp inside the field interior (never on/through a BORDER cell), across many seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const wisp of stage1WispsFor(mulberry32(seed))) {
        const { x, y } = wisp.getPosition();
        expect(x).toBeGreaterThanOrEqual(1);
        expect(x).toBeLessThanOrEqual(FIELD_WIDTH - 2);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(y).toBeLessThanOrEqual(FIELD_HEIGHT - 2);
      }
    }
  });

  it("keeps the spawn cluster's center at least WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN cells from the marker's start column, across many seeds", () => {
    const markerColumn = Math.floor(FIELD_WIDTH / 2);
    for (let seed = 0; seed < 50; seed++) {
      // Stage 1 has exactly one Wisp, so its x *is* the cluster center (no
      // spacing offset is applied for a single-Wisp cluster) — this is the
      // exact anti-exploit property the M12 center-line split relied on
      // the absence of.
      const [wisp] = stage1WispsFor(mulberry32(seed));
      const offset = Math.abs(wisp.getPosition().x - markerColumn);
      expect(offset).toBeGreaterThanOrEqual(WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN);
    }
  });

  it('produces an identical spawn cluster for the same injected rng (determinism)', () => {
    const a = stage1WispsFor(mulberry32(42)).map((w) => w.getPosition());
    const b = stage1WispsFor(mulberry32(42)).map((w) => w.getPosition());
    expect(a).toEqual(b);
  });

  it('spawns wispCount matching the stage config (docs/plan.md §12.7: stage n = n Wisps) even with the randomized spawn center', () => {
    // Stage-1-to-stage-2 progression with the *real* per-stage builder is
    // already covered end-to-end by the "spawns wispCount == stage number"
    // test above (which continues to pass unchanged with the randomized
    // spawn center); here we just re-confirm, across several seeds, that
    // randomizing the spawn center didn't change how many Wisps stage 1
    // asks for.
    for (let seed = 0; seed < 10; seed++) {
      const wisps = stage1WispsFor(mulberry32(seed));
      expect(wisps.length).toBe(getStageConfig(1).wispCount);
    }
  });
});

describe('GameSession — debug overrides persist across stage transitions (docs/plan.md §6 M10 / §12.4)', () => {
  it('carries an applied override into the next stage, and RESET clears it there too', () => {
    const session = new GameSession({ gameFactory: stageClearGame });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // stage 1, playing

    session.applyDebugOverrides({ wispCount: 3 });
    expect(session.getGame().getWisps().length).toBe(3);
    expect(session.hasActiveDebugOverrides()).toBe(true);

    clearStageClearGame(session);
    expect(session.getStatus()).toBe('stageclear');
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // advance -> stage 2, a fresh Game

    // The fresh stage-2 Game picks up the same override immediately, without
    // a fresh applyDebugOverrides() call.
    expect(session.getGame().getWisps().length).toBe(3);
    expect(session.hasActiveDebugOverrides()).toBe(true);

    session.resetDebugOverrides();
    expect(session.hasActiveDebugOverrides()).toBe(false);
    expect(session.getGame().getWisps().length).toBe(1); // stage 2's own default (stageClearGame's single Wisp)

    clearStageClearGame(session);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // advance -> stage 3

    // RESET's effect also persists forward: a brand-new stage doesn't
    // resurrect the override that was already cleared.
    expect(session.getGame().getWisps().length).toBe(1);
  });

  it("hasActiveDebugOverrides gates whether a run's score should be eligible for high-score persistence", () => {
    // main.ts checks GameSession.hasActiveDebugOverrides() before writing to
    // localStorage (docs/plan.md §6 M10: "デバッグパネル使用中はハイスコア
    // を保存しない") — this test asserts the API this decision is based on,
    // since main.ts itself is DOM-facing and out of core's unit-test scope.
    const session = new GameSession({ gameFactory: stageClearGame, highScore: 5 });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });

    clearStageClearGame(session);
    expect(session.getScore()).toBeGreaterThan(5);
    expect(session.hasActiveDebugOverrides()).toBe(false); // no override touched -> a real run's score is eligible

    session.applyDebugOverrides({ requiredOccupancy: 0.5 });
    expect(session.hasActiveDebugOverrides()).toBe(true); // now tainted -> should not be persisted while active

    session.resetDebugOverrides();
    expect(session.hasActiveDebugOverrides()).toBe(false); // back to eligible once every override is cleared
  });
});
