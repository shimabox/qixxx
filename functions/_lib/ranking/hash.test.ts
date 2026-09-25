import { describe, it, expect } from 'vitest';
import { encodeRle, InputSample } from '../../../src/core/rle';
import { computeReplayHash } from './hash';

const sample = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean, slow: boolean): InputSample => ({ dx, dy, drawHeld, slow });

describe('computeReplayHash', () => {
  it('is deterministic for the same inputs', async () => {
    const rle = encodeRle([sample(0, 1, true, false), sample(1, 0, false, false)]);
    const a = await computeReplayHash({ seasonId: 1, rulesetVersion: 1, seed: 42, rle });
    const b = await computeReplayHash({ seasonId: 1, rulesetVersion: 1, seed: 42, rle });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest
  });

  it('differs when season, ruleset, seed, or the sample content differs', async () => {
    const rle = encodeRle([sample(0, 1, true, false)]);
    const base = await computeReplayHash({ seasonId: 1, rulesetVersion: 1, seed: 1, rle });
    const differentSeason = await computeReplayHash({ seasonId: 2, rulesetVersion: 1, seed: 1, rle });
    const differentRuleset = await computeReplayHash({ seasonId: 1, rulesetVersion: 2, seed: 1, rle });
    const differentSeed = await computeReplayHash({ seasonId: 1, rulesetVersion: 1, seed: 2, rle });
    const differentSamples = await computeReplayHash({
      seasonId: 1,
      rulesetVersion: 1,
      seed: 1,
      rle: encodeRle([sample(1, 0, true, false)]),
    });
    const all = [base, differentSeason, differentRuleset, differentSeed, differentSamples];
    expect(new Set(all).size).toBe(all.length);
  });

  it('normalizes equivalent RLE encodings of the same sample sequence to the same hash (anti-resubmission)', async () => {
    const samples: InputSample[] = [sample(0, 1, true, false), sample(0, 1, true, false), sample(0, 1, true, false)];
    // Two RLE byte streams that decode to the *same* sample sequence but are
    // split differently: one as a single run-of-3, one as three runs-of-1.
    const singleRun = encodeRle(samples);
    const splitRuns = new Uint8Array([
      ...encodeRle([samples[0]]),
      ...encodeRle([samples[1]]),
      ...encodeRle([samples[2]]),
    ]);
    expect(singleRun).not.toEqual(splitRuns); // sanity: genuinely different byte streams

    const hashA = await computeReplayHash({ seasonId: 1, rulesetVersion: 1, seed: 9, rle: singleRun });
    const hashB = await computeReplayHash({ seasonId: 1, rulesetVersion: 1, seed: 9, rle: splitRuns });
    expect(hashA).toBe(hashB);
  });
});
