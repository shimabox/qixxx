// Ember unit tests (docs/plan.md §7.1: "外周敵: BORDER グラフ上を移動し
// UNCLAIMED に入らない / 分岐で直前セルに戻らない"). The third required case
// — "マーカー接触でミス（game 経由）" — is deliberately exercised at the
// Game level (see game.test.ts), since it requires Field + Marker + Game
// wiring that this module intentionally does not depend on.
import { describe, it, expect } from 'vitest';
import { Ember, Heading } from './patrol';
import { BORDER } from './field';
import { EMBER_MOVE_TICKS } from '../config';
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
