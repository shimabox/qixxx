import { describe, it, expect } from 'vitest';
import { getStageConfig } from './stage';
import { TICK_RATE, WISP_SPEED_MULTIPLIER_MAX, EMBER_SPAWN_INTERVAL_MIN_SEC, REQUIRED_OCCUPANCY_MAX } from '../config';

describe('getStageConfig (docs/plan.md §3.7)', () => {
  it('stage 1: 1 Wisp, baseline speed, 30s Ember interval, 65% required', () => {
    const config = getStageConfig(1);
    expect(config.stage).toBe(1);
    expect(config.wispCount).toBe(1);
    expect(config.wispSpeedMultiplier).toBe(1);
    expect(config.emberSpawnIntervalTicks).toBe(30 * TICK_RATE);
    expect(config.requiredOccupancy).toBeCloseTo(0.65);
  });

  it('stage 2: 1 Wisp, x1.15 speed, 25s Ember interval, same 65% required', () => {
    const config = getStageConfig(2);
    expect(config.wispCount).toBe(1);
    expect(config.wispSpeedMultiplier).toBeCloseTo(1.15);
    expect(config.emberSpawnIntervalTicks).toBe(25 * TICK_RATE);
    expect(config.requiredOccupancy).toBeCloseTo(0.65);
  });

  it('stage 3: 2 Wisps, and every parameter has already escalated past stage 2', () => {
    const stage2 = getStageConfig(2);
    const stage3 = getStageConfig(3);

    expect(stage3.wispCount).toBe(2);
    expect(stage3.wispSpeedMultiplier).toBeGreaterThan(stage2.wispSpeedMultiplier);
    expect(stage3.emberSpawnIntervalTicks).toBeLessThan(stage2.emberSpawnIntervalTicks);
    expect(stage3.requiredOccupancy).toBeGreaterThan(stage2.requiredOccupancy);
  });

  it('stage 3+ escalates monotonically stage over stage, never regressing', () => {
    let previous = getStageConfig(3);
    for (let stage = 4; stage <= 12; stage++) {
      const current = getStageConfig(stage);
      expect(current.wispCount).toBe(2);
      expect(current.wispSpeedMultiplier).toBeGreaterThanOrEqual(previous.wispSpeedMultiplier);
      expect(current.emberSpawnIntervalTicks).toBeLessThanOrEqual(previous.emberSpawnIntervalTicks);
      expect(current.requiredOccupancy).toBeGreaterThanOrEqual(previous.requiredOccupancy);
      previous = current;
    }
  });

  it('caps Wisp speed at the documented x2 bound, however far the stage number climbs', () => {
    const config = getStageConfig(50);
    expect(config.wispSpeedMultiplier).toBe(WISP_SPEED_MULTIPLIER_MAX);
    expect(config.wispSpeedMultiplier).toBe(2);
  });

  it('floors the Ember spawn interval at the documented 10s bound, however far the stage number climbs', () => {
    const config = getStageConfig(50);
    expect(config.emberSpawnIntervalTicks).toBe(EMBER_SPAWN_INTERVAL_MIN_SEC * TICK_RATE);
    expect(config.emberSpawnIntervalTicks).toBe(10 * TICK_RATE);
  });

  it('caps required occupancy at the documented 75% bound, however far the stage number climbs', () => {
    const config = getStageConfig(50);
    expect(config.requiredOccupancy).toBeCloseTo(REQUIRED_OCCUPANCY_MAX);
    expect(config.requiredOccupancy).toBeCloseTo(0.75);
  });

  it('normalizes a sub-1 or fractional stage number to stage 1', () => {
    expect(getStageConfig(0)).toEqual(getStageConfig(1));
    expect(getStageConfig(-5)).toEqual(getStageConfig(1));
    expect(getStageConfig(1.9)).toEqual(getStageConfig(1));
  });
});
