// Ember unit tests (docs/plan.md §7.1: "外周敵: BORDER グラフ上を移動し
// UNCLAIMED に入らない / 分岐で直前セルに戻らない"). The third required case
// — "マーカー接触でミス（game 経由）" — is deliberately exercised at the
// Game level (see game.test.ts), since it requires Field + Marker + Game
// wiring that this module intentionally does not depend on.
import { describe, it, expect } from 'vitest';
import { Ember, Heading } from './patrol';
import { BORDER, LINE } from './field';
import { EMBER_MOVE_TICKS, EMBER_BRANCH_CHASE_PROBABILITY } from '../config';
import { parseField } from './fieldFixture';

describe('Ember (docs/plan.md §3.4 (2) / §4.3 — border-patrol enemy)', () => {
  it('stays on the BORDER graph, never entering UNCLAIMED, while circling a simple rectangle', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      ##########
    `);
    const heading: Heading = { dx: 1, dy: 0 };
    const ember = new Ember({ x: 0, y: 0 }, heading);
    const farAwayTarget = { x: 5, y: 2 };

    for (let tick = 0; tick < 200; tick++) {
      ember.update(parsed.field, farAwayTarget);
      const pos = ember.getPosition();
      expect(parsed.field.isInBounds(pos)).toBe(true);
      expect(parsed.field.get(pos)).toBe(BORDER);
    }
  });

  it('getPositionRef() returns the same coordinates as getPosition() at every step (a non-cloning reference)', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      ##########
    `);
    const heading: Heading = { dx: 1, dy: 0 };
    const ember = new Ember({ x: 0, y: 0 }, heading);
    const farAwayTarget = { x: 5, y: 2 };

    for (let tick = 0; tick < 20; tick++) {
      ember.update(parsed.field, farAwayTarget);
      expect(ember.getPositionRef()).toEqual(ember.getPosition());
    }
  });

  it('advances exactly one BORDER cell every EMBER_MOVE_TICKS ticks (throttled, slower than the marker)', () => {
    const parsed = parseField(`
      ##########
      #........#
      #........#
      #........#
      ##########
    `);
    const ember = new Ember({ x: 0, y: 0 }, { dx: 1, dy: 0 });
    const target = { x: 9, y: 0 };

    expect(ember.getPosition()).toEqual({ x: 0, y: 0 });
    ember.update(parsed.field, target); // first tick always moves (the cooldown starts at 0)
    expect(ember.getPosition()).toEqual({ x: 1, y: 0 });

    for (let tick = 0; tick < EMBER_MOVE_TICKS - 1; tick++) {
      ember.update(parsed.field, target);
      expect(ember.getPosition()).toEqual({ x: 1, y: 0 }); // still on cooldown
    }
    ember.update(parsed.field, target); // cooldown elapsed: moves again
    expect(ember.getPosition()).toEqual({ x: 2, y: 0 });
  });

  it('never reverses into the cell it just came from at a branch, and steers toward the target direction', () => {
    // A "T" shaped border network: a horizontal dead-end corridor along y=1
    // (x=0..5) that forks at its end (5,1) into an upward dead-end (5,0) and
    // a two-cell downward branch (5,2)-(5,3). Since the corridor doesn't
    // continue past x=5, "maintain heading" (+x) is unavailable at the fork,
    // forcing a real branch decision.
    const parsed = parseField(`
      .....#....
      ######....
      .....#....
      .....#....
    `);
    const start = { x: 0, y: 1 };
    const ember = new Ember(start, { dx: 1, dy: 0 });
    const targetBelow = { x: 5, y: 3 };

    // 6 steps: 5 to walk the corridor from (0,1) to the fork (5,1), plus 1
    // more to resolve the branch.
    for (let tick = 0; tick < EMBER_MOVE_TICKS * 6; tick++) {
      ember.update(parsed.field, targetBelow);
      // Always on the BORDER graph, and never back at the corridor's start
      // (which would mean it reversed all the way back).
      expect(parsed.field.get(ember.getPosition())).toBe(BORDER);
      expect(ember.getPosition()).not.toEqual(start);
    }

    // Target is below the fork -> it must have taken the downward branch,
    // not doubled back along y=1 or gone up to the dead end at (5,0).
    expect(ember.getPosition()).toEqual({ x: 5, y: 2 });
  });
});

describe('Ember — probabilistic branch-chase (docs/plan.md §6 M8 / §12.2)', () => {
  // A horizontal corridor along y=1 (x=0..9, all BORDER) crossed at x=5 by a
  // vertical stub: a dead end above at (5,0) and a two-cell branch below at
  // (5,2)-(5,3). Unlike patrol.test.ts's earlier "T" fixture, the corridor
  // *continues straight* past the crossing (x=6..9 is still BORDER on y=1),
  // so "keep going straight" is genuinely available at the fork — this is
  // what lets these tests tell "always chase" and "always go straight" apart.
  const CROSSROADS = `
    .....#....
    ##########
    .....#....
    .....#....
  `;
  const START = { x: 0, y: 1 };
  const STRAIGHT_HEADING: Heading = { dx: 1, dy: 0 };
  const TARGET_BELOW = { x: 5, y: 3 }; // pulls the marker-ward candidate downward at the fork
  // 5 corridor steps ((0,1) -> (5,1)) + 1 more tick to resolve the fork.
  const TICKS_TO_RESOLVE_FORK = EMBER_MOVE_TICKS * 6;

  it('(a) rolls chase at the branch and turns onto the marker-ward inner border, even though straight is available', () => {
    const parsed = parseField(CROSSROADS);
    const alwaysChase = () => EMBER_BRANCH_CHASE_PROBABILITY / 2; // always below the threshold
    const ember = new Ember(START, STRAIGHT_HEADING, alwaysChase);

    for (let tick = 0; tick < TICKS_TO_RESOLVE_FORK; tick++) {
      ember.update(parsed.field, TARGET_BELOW);
    }

    // Turned downward onto the inner branch toward the marker instead of
    // continuing straight through the crossing.
    expect(ember.getPosition()).toEqual({ x: 5, y: 2 });
  });

  it('(b) does not roll chase when rng lands above the threshold, and keeps going straight through the branch', () => {
    const parsed = parseField(CROSSROADS);
    const neverChase = () => (EMBER_BRANCH_CHASE_PROBABILITY + 1) / 2; // always above the threshold
    const ember = new Ember(START, STRAIGHT_HEADING, neverChase);

    for (let tick = 0; tick < TICKS_TO_RESOLVE_FORK; tick++) {
      ember.update(parsed.field, TARGET_BELOW);
    }

    // Same fixture and same target as (a) — only the rng differs — yet it
    // continues straight (maintains heading) instead of turning.
    expect(ember.getPosition()).toEqual({ x: 6, y: 1 });
  });

  it('(c) ignores rng entirely on a non-branch (corridor) cell and keeps heading', () => {
    const parsed = parseField(CROSSROADS);
    // Would always roll chase if this cell were a branch point — it isn't
    // (only one non-reversing candidate exists along the plain corridor),
    // so the roll must never even be consulted.
    const alwaysChaseIfAsked = () => 0;
    const ember = new Ember(START, STRAIGHT_HEADING, alwaysChaseIfAsked);

    ember.update(parsed.field, TARGET_BELOW); // first tick always moves (cooldown starts at 0)

    expect(ember.getPosition()).toEqual({ x: 1, y: 1 });
  });

  it('(d) never reverses into the cell it just came from at the branch, even when the marker sits behind it', () => {
    const parsed = parseField(CROSSROADS);
    const alwaysChase = () => EMBER_BRANCH_CHASE_PROBABILITY / 2; // force the chase roll every tick
    const ember = new Ember(START, STRAIGHT_HEADING, alwaysChase);
    // The marker sits exactly where Ember came from (behind it, along -x) —
    // if the "never reverse" constraint were dropped, the dot-product chase
    // would happily walk straight back the way it came.
    const targetBehind = { x: 4, y: 1 };

    // Tracks the sequence of *distinct* cells visited so far, so each new
    // cell can be checked against the one immediately before it (the true
    // "cell it just came from"), not just the original start point.
    const visited = [ember.getPosition()];
    for (let tick = 0; tick < TICKS_TO_RESOLVE_FORK; tick++) {
      ember.update(parsed.field, targetBehind);
      const after = ember.getPosition();
      const last = visited[visited.length - 1];
      if (after.x !== last.x || after.y !== last.y) {
        const cameFrom = visited[visited.length - 2] ?? last;
        expect(after).not.toEqual(cameFrom);
        visited.push(after);
      }
    }

    // At the fork, the reverse (left, back along the corridor) is excluded,
    // so among the remaining candidates (up/right/down) the tie-broken best
    // toward (4,1) is "up" (first in iteration order at score 0) — not a
    // reversal back into the corridor.
    expect(ember.getPosition()).toEqual({ x: 5, y: 0 });
  });
});

describe('Ember — Blaze line entry (docs/plan.md §14 M6-1)', () => {
  // A BORDER ring with a 3-cell LINE stub hanging off the top border at
  // x=5 (a one-way, branchless corridor once entered — the only way a
  // Blaze descending it can ever move is further down or back the way it
  // came, and "never reverse" already rules out the latter).
  const LINE_STUB = `
    ##########
    #....L...#
    #....L...#
    #....L...#
    ##########
  `;

  it('isBlaze() reflects the constructor flag, defaulting to false', () => {
    const heading: Heading = { dx: 1, dy: 0 };
    expect(new Ember({ x: 0, y: 0 }, heading).isBlaze()).toBe(false);
    expect(
      new Ember({ x: 0, y: 0 }, heading, Math.random, EMBER_MOVE_TICKS, EMBER_BRANCH_CHASE_PROBABILITY, true).isBlaze()
    ).toBe(true);
  });

  it('canEnterLine=true steps from BORDER onto a LINE cell and keeps climbing it to the far BORDER', () => {
    const parsed = parseField(LINE_STUB);
    const downHeading: Heading = { dx: 0, dy: 1 };
    const target = { x: 5, y: 3 }; // irrelevant once inside the branchless LINE corridor
    const blaze = new Ember({ x: 5, y: 0 }, downHeading, () => 1, 1, 0, /* canEnterLine */ true);
    expect(blaze.isBlaze()).toBe(true);

    blaze.update(parsed.field, target); // (5,0) -> (5,1)
    expect(parsed.field.get(blaze.getPosition())).toBe(LINE);
    expect(blaze.getPosition()).toEqual({ x: 5, y: 1 });

    blaze.update(parsed.field, target); // (5,1) -> (5,2)
    expect(blaze.getPosition()).toEqual({ x: 5, y: 2 });

    blaze.update(parsed.field, target); // (5,2) -> (5,3)
    expect(blaze.getPosition()).toEqual({ x: 5, y: 3 });

    blaze.update(parsed.field, target); // (5,3) -> (5,4): back onto BORDER at the far end
    expect(blaze.getPosition()).toEqual({ x: 5, y: 4 });
    expect(parsed.field.get(blaze.getPosition())).toBe(BORDER);
  });

  it('canEnterLine=false (default) never steps onto a LINE cell, even heading straight at one', () => {
    const parsed = parseField(LINE_STUB);
    const downHeading: Heading = { dx: 0, dy: 1 };
    const target = { x: 0, y: 0 };
    const ember = new Ember({ x: 5, y: 0 }, downHeading, () => 1, 1, 0); // canEnterLine defaults to false
    expect(ember.isBlaze()).toBe(false);

    for (let tick = 0; tick < 10; tick++) {
      ember.update(parsed.field, target);
      expect(parsed.field.get(ember.getPosition())).not.toBe(LINE);
    }
  });

  it('at a branch offering a LINE candidate, a chasing Blaze climbs toward the marker even when heading points elsewhere', () => {
    const parsed = parseField(LINE_STUB);
    const rightHeading: Heading = { dx: 1, dy: 0 }; // "maintain heading" would prefer +x, not the LINE stub below
    const alwaysChase = () => 0; // always rolls the branch-chase, whatever the threshold
    const targetBelow = { x: 5, y: 3 };
    const blaze = new Ember({ x: 5, y: 0 }, rightHeading, alwaysChase, 1, 0.5, true);

    for (let tick = 0; tick < 4; tick++) {
      blaze.update(parsed.field, targetBelow);
    }

    // Descended the LINE stub (rather than continuing along the top border)
    // and walked off its far end back onto BORDER.
    expect(blaze.getPosition()).toEqual({ x: 5, y: 4 });
  });
});
