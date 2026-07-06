import { describe, it, expect } from 'vitest';
import { getStageConfig } from './stage';
import { TICK_RATE, WISP_SPEED_MULTIPLIER_MAX, EMBER_SPAWN_INTERVAL_MIN_SEC, REQUIRED_OCCUPANCY_MAX } from '../config';

// docs/plan.md §12.7 replaced the earlier §3.7 step-based table (stage 1/2
// fixed values, stage 3+ 2-Wisp escalation) with a single linear
// interpolation from stage 1 (baseline) to stage 10 (every parameter at its
// documented max), held flat for stage 11+. These tests exercise the curve
// at stage 1 (baseline), stage 5 (midpoint), stage 10 (the max), and stage
// 11 (proof that "max, held flat" actually holds beyond stage 10) — per the
// M12 orchestration brief's requested checkpoints — rather than every stage
// individually, since the interpolation formula (checked directly here) is
// what determines every stage in between.
describe('getStageConfig (docs/plan.md §12.7)', () => {
  it('stage 1: 1 Wisp, baseline speed/Ember tuning, 65% required', () => {
    const config = getStageConfig(1);
    expect(config.stage).toBe(1);
    expect(config.wispCount).toBe(1);
    expect(config.wispSpeedMultiplier).toBe(1);
    expect(config.emberMoveTicks).toBe(3);
    expect(config.emberBranchChaseProbability).toBeCloseTo(0.7);
    expect(config.emberSpawnIntervalTicks).toBe(30 * TICK_RATE);
    expect(config.maxConcurrentEmbers).toBe(2);
    expect(config.requiredOccupancy).toBeCloseTo(0.65);
  });

  it('stage 5: every parameter at its documented midpoint value', () => {
    const config = getStageConfig(5);
    expect(config.wispCount).toBe(5);
    expect(config.wispSpeedMultiplier).toBeCloseTo(2.7778, 3);
    expect(config.emberMoveTicks).toBe(2);
    expect(config.emberBranchChaseProbability).toBeCloseTo(0.8333, 3);
    expect(config.emberSpawnIntervalTicks).toBe(19 * TICK_RATE);
    expect(config.maxConcurrentEmbers).toBe(6);
    expect(config.requiredOccupancy).toBeCloseTo(0.76);
  });

  it('stage 10: every parameter at its documented max (docs/plan.md §12.7 table)', () => {
    const config = getStageConfig(10);
    expect(config.wispCount).toBe(10);
    expect(config.wispSpeedMultiplier).toBe(5.0);
    expect(config.wispSpeedMultiplier).toBe(WISP_SPEED_MULTIPLIER_MAX);
    expect(config.emberMoveTicks).toBe(1);
    expect(config.emberBranchChaseProbability).toBe(1.0);
    expect(config.emberSpawnIntervalTicks).toBe(EMBER_SPAWN_INTERVAL_MIN_SEC * TICK_RATE);
    expect(config.emberSpawnIntervalTicks).toBe(5 * TICK_RATE);
    expect(config.maxConcurrentEmbers).toBe(10);
    expect(config.requiredOccupancy).toBeCloseTo(REQUIRED_OCCUPANCY_MAX);
    expect(config.requiredOccupancy).toBeCloseTo(0.9);
  });

  it('stage 11+: held exactly at the stage-10 max, not exceeding it', () => {
    const stage10 = getStageConfig(10);
    const stage11 = getStageConfig(11);
    const stage50 = getStageConfig(50);

    // Wisp count caps at 10 (docs/plan.md §12.7: "10匹上限"), unlike stage
    // number itself which would otherwise keep climbing.
    expect(stage11.wispCount).toBe(10);
    expect(stage50.wispCount).toBe(10);

    for (const config of [stage11, stage50]) {
      expect(config.wispSpeedMultiplier).toBe(stage10.wispSpeedMultiplier);
      expect(config.emberMoveTicks).toBe(stage10.emberMoveTicks);
      expect(config.emberBranchChaseProbability).toBe(stage10.emberBranchChaseProbability);
      expect(config.emberSpawnIntervalTicks).toBe(stage10.emberSpawnIntervalTicks);
      expect(config.maxConcurrentEmbers).toBe(stage10.maxConcurrentEmbers);
      expect(config.requiredOccupancy).toBe(stage10.requiredOccupancy);
    }
  });

  it('escalates monotonically stage over stage, never regressing, from stage 1 through stage 10', () => {
    let previous = getStageConfig(1);
    for (let stage = 2; stage <= 10; stage++) {
      const current = getStageConfig(stage);
      expect(current.wispCount).toBeGreaterThanOrEqual(previous.wispCount);
      expect(current.wispSpeedMultiplier).toBeGreaterThanOrEqual(previous.wispSpeedMultiplier);
      expect(current.emberMoveTicks).toBeLessThanOrEqual(previous.emberMoveTicks);
      expect(current.emberBranchChaseProbability).toBeGreaterThanOrEqual(previous.emberBranchChaseProbability);
      expect(current.emberSpawnIntervalTicks).toBeLessThanOrEqual(previous.emberSpawnIntervalTicks);
      expect(current.maxConcurrentEmbers).toBeGreaterThanOrEqual(previous.maxConcurrentEmbers);
      expect(current.requiredOccupancy).toBeGreaterThanOrEqual(previous.requiredOccupancy);
      previous = current;
    }
  });

  it('required occupancy matches the documented per-stage percent-point table exactly (docs/plan.md §12.7)', () => {
    const expectedPercents = [65, 68, 71, 73, 76, 79, 82, 84, 87, 90];
    for (let stage = 1; stage <= 10; stage++) {
      const config = getStageConfig(stage);
      expect(Math.round(config.requiredOccupancy * 100)).toBe(expectedPercents[stage - 1]);
    }
  });

  it('normalizes a sub-1 or fractional stage number to stage 1', () => {
    expect(getStageConfig(0)).toEqual(getStageConfig(1));
    expect(getStageConfig(-5)).toEqual(getStageConfig(1));
    expect(getStageConfig(1.9)).toEqual(getStageConfig(1));
  });
});
