import { describe, it, expect } from 'vitest';
import { getStageConfig } from './stage';
import { Game } from './game';
import { Field } from './field';
import { Wisp } from './enemy';
import { GameSession } from './session';
import { TICK_RATE, EMBER_FIRST_SPAWN_SEC } from '../config';

// Every stage has its own values (config.ts's STAGE_TABLE). The expected
// rows below are the stage table as designed, written out by hand so a change
// to the table shows up here: title, Wisps, speed, Ember interval (s), first
// Ember (s), max Embers, Ember move ticks, goal (%).
const EXPECTED: ReadonlyArray<[string, number, number, number, number, number, number, number]> = [
  ['warmUp', 1, 1.0, 30, 15, 2, 3, 65],
  ['sprinter', 1, 2.8, 18, 18, 3, 2, 70],
  ['fastPair', 2, 2.4, 16, 16, 4, 2, 72],
  ['slowSwarm', 6, 1.2, 20, 20, 4, 2, 60],
  ['emberRush', 3, 2.4, 10, 10, 6, 2, 75],
  ['breather', 2, 1.6, 26, 26, 2, 3, 60],
  ['quartet', 4, 2.4, 15, 15, 6, 2, 78],
  ['fastFour', 4, 2.8, 12, 12, 7, 2, 80],
  ['quintet', 5, 2.8, 10, 10, 8, 1, 80],
  ['fastFive', 5, 3.0, 8, 8, 8, 1, 80],
  ['bigSwarm', 8, 1.4, 16, 16, 4, 2, 65],
  ['emberStorm', 3, 2.8, 6, 6, 10, 1, 78],
  ['sextet', 6, 2.6, 10, 10, 8, 1, 80],
  ['fastSix', 6, 3.0, 8, 8, 8, 1, 80],
  ['final', 7, 3.0, 8, 8, 10, 1, 80],
];

// The stages outside the scoring stages (4, 11) and the breather (6).
const MAIN_LINE = [1, 2, 3, 5, 7, 8, 9, 10, 12, 13, 14, 15];

describe('getStageConfig (stage table)', () => {
  for (let i = 0; i < EXPECTED.length; i++) {
    const stage = i + 1;
    const [titleId, wisps, speed, intervalSec, firstSec, maxEmbers, moveTicks, goalPercent] = EXPECTED[i];
    it(`stage ${stage}: ${titleId}`, () => {
      const config = getStageConfig(stage);
      expect(config.stage).toBe(stage);
      expect(config.titleId).toBe(titleId);
      expect(config.wispCount).toBe(wisps);
      expect(config.wispSpeedMultiplier).toBe(speed);
      expect(config.emberSpawnIntervalTicks).toBe(intervalSec * TICK_RATE);
      expect(config.firstEmberSpawnTicks).toBe(firstSec * TICK_RATE);
      expect(config.maxConcurrentEmbers).toBe(maxEmbers);
      expect(config.emberMoveTicks).toBe(moveTicks);
      expect(Math.round(config.requiredOccupancy * 100)).toBe(goalPercent);
    });
  }

  it('stage 16 and later play stage 15', () => {
    const stage15 = getStageConfig(15);
    for (const stage of [16, 17, 50, 999]) {
      expect({ ...getStageConfig(stage), stage: 15 }).toEqual(stage15);
      expect(getStageConfig(stage).stage).toBe(stage);
    }
  });

  it("stage 1's first Ember waits EMBER_FIRST_SPAWN_SEC (15s)", () => {
    expect(EMBER_FIRST_SPAWN_SEC).toBe(15);
    expect(getStageConfig(1).firstEmberSpawnTicks).toBe(EMBER_FIRST_SPAWN_SEC * TICK_RATE);
  });

  it('outside the scoring stages and the breather, no step raises both the Wisp count and the speed', () => {
    for (let i = 1; i < MAIN_LINE.length; i++) {
      const previous = getStageConfig(MAIN_LINE[i - 1]);
      const current = getStageConfig(MAIN_LINE[i]);
      const moreWisps = current.wispCount > previous.wispCount;
      const faster = current.wispSpeedMultiplier > previous.wispSpeedMultiplier;
      expect(moreWisps && faster, `stage ${previous.stage} -> ${current.stage}`).toBe(false);
    }
  });

  it('no stage is faster than x3.0 or has a goal above 80%', () => {
    for (let stage = 1; stage <= 20; stage++) {
      const config = getStageConfig(stage);
      expect(config.wispSpeedMultiplier).toBeLessThanOrEqual(3.0);
      expect(config.requiredOccupancy).toBeLessThanOrEqual(0.8);
    }
  });

  it('keeps the branch-chase probability on its line from 0.7 (stage 1) to 1.0 (stage 4 and later)', () => {
    expect(getStageConfig(1).emberBranchChaseProbability).toBeCloseTo(0.7);
    expect(getStageConfig(2).emberBranchChaseProbability).toBeCloseTo(0.8);
    expect(getStageConfig(3).emberBranchChaseProbability).toBeCloseTo(0.9);
    expect(getStageConfig(4).emberBranchChaseProbability).toBe(1.0);
    expect(getStageConfig(5).emberBranchChaseProbability).toBe(1.0);
    expect(getStageConfig(10).emberBranchChaseProbability).toBe(1.0);
    expect(getStageConfig(11).emberBranchChaseProbability).toBe(1.0);
    expect(getStageConfig(15).emberBranchChaseProbability).toBe(1.0);
  });

  it('normalizes a sub-1 or fractional stage number to stage 1', () => {
    expect(getStageConfig(0)).toEqual(getStageConfig(1));
    expect(getStageConfig(-5)).toEqual(getStageConfig(1));
    expect(getStageConfig(1.9)).toEqual(getStageConfig(1));
    expect(getStageConfig(2.7)).toEqual(getStageConfig(2));
  });
});

describe('the first Ember pair', () => {
  /** Ticks at which an Ember pair appears, over `ticks` updates of an idle Game. */
  function spawnTicks(game: Game, ticks: number): number[] {
    const at: number[] = [];
    for (let tick = 1; tick <= ticks; tick++) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
      if (game.drainEvents().some((e) => e === 'ember-spawned' || e === 'ember-blaze-spawned')) at.push(tick);
    }
    return at;
  }

  it('on stage 1 of a real run comes 15s in', () => {
    const session = new GameSession({ seed: 1 });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    const at: number[] = [];
    for (let tick = 1; tick <= 20 * TICK_RATE && session.getStatus() === 'playing'; tick++) {
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
      if (session.drainEvents().some((e) => e === 'ember-spawned' || e === 'ember-blaze-spawned')) at.push(tick);
    }
    // The cooldown counts down once per tick and spawns on the tick after it
    // reaches 0, so the pair is one tick past its whole-second mark.
    expect(at).toEqual([15 * TICK_RATE + 1]);
  });

  it("with stage 1's values comes 15s in, then every 30s", () => {
    const config = getStageConfig(1);
    const field = new Field(20, 15);
    const wisp = new Wisp({ x: 10, y: 7 }, () => 0.5);
    // A cap high enough that no cycle is skipped, so every cycle shows, and
    // lives enough that the Embers reaching the idle marker never end it.
    const game = new Game(field, undefined, wisp, () => 0.5, {
      emberSpawnIntervalTicks: config.emberSpawnIntervalTicks,
      firstEmberSpawnTicks: config.firstEmberSpawnTicks,
      maxConcurrentEmbers: 100,
      lives: 1_000_000,
    });
    expect(spawnTicks(game, 80 * TICK_RATE)).toEqual([15 * TICK_RATE + 1, 45 * TICK_RATE + 2, 75 * TICK_RATE + 3]);
  });

  it('defaults to the spawn interval when no first spawn is given', () => {
    const field = new Field(20, 15);
    const wisp = new Wisp({ x: 10, y: 7 }, () => 0.5);
    const game = new Game(field, undefined, wisp, () => 0.5, { emberSpawnIntervalTicks: 10, maxConcurrentEmbers: 10 });
    expect(spawnTicks(game, 25)).toEqual([11, 22]);
  });

  it('uses firstEmberSpawnTicks for the first pair only', () => {
    const field = new Field(20, 15);
    const wisp = new Wisp({ x: 10, y: 7 }, () => 0.5);
    const game = new Game(field, undefined, wisp, () => 0.5, {
      emberSpawnIntervalTicks: 10,
      firstEmberSpawnTicks: 3,
      maxConcurrentEmbers: 10,
    });
    expect(spawnTicks(game, 25)).toEqual([4, 15]);
  });
});
