import { describe, it, expect, vi, afterEach } from 'vitest';
import { bannerGlitch, popupBounceScale, popupChannelOffset } from './textGlitch';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bannerGlitch', () => {
  it('cuts SPLIT! into the three bands of the table on ticks 0-8', () => {
    for (let tick = 0; tick <= 8; tick++) {
      const odd = tick % 2 === 1;
      expect(bannerGlitch(tick, false)).toEqual({
        bands: [
          { from: -0.71, to: -0.24, dx: odd ? 0.19 : -0.14 },
          { from: -0.24, to: 0.17, dx: tick % 3 === 0 ? 0.17 : -0.12 },
          { from: 0.17, to: 0.71, dx: odd ? -0.17 : 0.1 },
        ],
        channelOffset: (10 - tick) * 0.012,
        alpha: tick === 2 || tick === 5 ? 0.45 : 1,
      });
    }
  });

  it('dims to 0.45 on ticks 2 and 5 only', () => {
    const alphas = Array.from({ length: 12 }, (_, tick) => bannerGlitch(tick, false).alpha);
    expect(alphas).toEqual([1, 1, 0.45, 1, 1, 0.45, 1, 1, 1, 1, 1, 1]);
  });

  it('is one steady piece from tick 9 on', () => {
    for (const tick of [9, 10, 30, 59, 1000]) {
      expect(bannerGlitch(tick, false)).toEqual({ bands: [{ from: -1, to: 1, dx: 0 }], channelOffset: 0, alpha: 1 });
    }
  });

  it('is always one steady piece with reduced motion', () => {
    for (let tick = 0; tick < 20; tick++) {
      expect(bannerGlitch(tick, true)).toEqual({ bands: [{ from: -1, to: 1, dx: 0 }], channelOffset: 0, alpha: 1 });
    }
  });

  it('can be made shorter or longer (debug tuning)', () => {
    expect(bannerGlitch(3, false, 3).bands).toHaveLength(1);
    expect(bannerGlitch(2, false, 3).bands).toHaveLength(3);
  });

  it('returns a fresh object every call', () => {
    const a = bannerGlitch(20, false);
    a.bands[0].dx = 5;
    expect(bannerGlitch(20, false).bands[0].dx).toBe(0);
  });
});

describe('popupChannelOffset', () => {
  it('is (5 - tick x 0.7) x 0.036 on ticks 0-5, all positive, and 0 from tick 6', () => {
    for (let tick = 0; tick <= 5; tick++) {
      const offset = popupChannelOffset(tick, false);
      expect(offset).toBeCloseTo((5 - tick * 0.7) * 0.036, 12);
      expect(offset).toBeGreaterThan(0);
    }
    for (const tick of [6, 7, 40, 1000]) expect(popupChannelOffset(tick, false)).toBe(0);
  });

  it('is always 0 with reduced motion', () => {
    for (let tick = 0; tick < 12; tick++) expect(popupChannelOffset(tick, true)).toBe(0);
  });
});

describe('popupBounceScale', () => {
  it('holds 1.4 on ticks 0-2, falls in a straight line to 1.0 on tick 7, then stays 1.0', () => {
    const scales = Array.from({ length: 12 }, (_, tick) => popupBounceScale(tick));
    expect(scales.slice(0, 3)).toEqual([1.4, 1.4, 1.4]);
    const steps = scales.slice(2, 8).map((s, i, all) => (i === 0 ? 0 : all[i - 1] - s)).slice(1);
    for (const step of steps) expect(step).toBeCloseTo(0.08, 10);
    expect(scales[7]).toBeCloseTo(1, 10);
    expect(scales.slice(8)).toEqual([1, 1, 1, 1]);
  });
});

describe('no randomness', () => {
  it('never calls Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    for (let tick = 0; tick < 20; tick++) {
      bannerGlitch(tick, false);
      popupChannelOffset(tick, false);
      popupBounceScale(tick);
    }
    expect(random).not.toHaveBeenCalled();
  });
});
