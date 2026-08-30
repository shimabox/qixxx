// duration_ticks must be derived
// server-side from the RLE stream's own sample count (a decode-only pass),
// never trusted from the client and never derived by resimulating.
import { describe, it, expect } from 'vitest';
import { deriveDurationTicksFromRle } from './rleDuration';
import { encodeRle, RleDecodeError, type InputSample } from '../../../src/core/rle';

const S = (dx: -1 | 0 | 1, dy: -1 | 0 | 1): InputSample => ({ dx, dy, drawHeld: false, slow: false });

describe('deriveDurationTicksFromRle', () => {
  it('returns 0 for an empty stream', () => {
    expect(deriveDurationTicksFromRle(encodeRle([]))).toBe(0);
  });

  it('returns the exact sample count for a short, varied stream', () => {
    const samples = [S(0, 1), S(1, 0), S(1, 0), S(-1, -1)];
    expect(deriveDurationTicksFromRle(encodeRle(samples))).toBe(samples.length);
  });

  it('sums run lengths correctly across a long repeated run (multi-byte varint)', () => {
    const samples = Array(10800).fill(S(0, 1));
    expect(deriveDurationTicksFromRle(encodeRle(samples))).toBe(10800);
  });

  it('sums correctly across multiple runs of different samples', () => {
    const samples = [...Array(50).fill(S(0, 1)), ...Array(200).fill(S(-1, -1)), ...Array(3).fill(S(1, 0))];
    expect(deriveDurationTicksFromRle(encodeRle(samples))).toBe(253);
  });

  it('throws RleDecodeError (propagated, not swallowed) for a malformed stream', () => {
    expect(() => deriveDurationTicksFromRle(new Uint8Array([255, 1]))).toThrow(RleDecodeError);
  });

  it('respects a custom maxTotalSamples cap', () => {
    const samples = Array(101).fill(S(0, 1));
    expect(() => deriveDurationTicksFromRle(encodeRle(samples), 100)).toThrow(RleDecodeError);
  });
});
