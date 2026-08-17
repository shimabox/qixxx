import { describe, it, expect } from 'vitest';
import { InputSample, encodeSampleByte, decodeSampleByte, encodeRle, decodeRleRuns, decodeRleToSamples } from './rle';

function sample(dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean, slow: boolean): InputSample {
  return { dx, dy, drawHeld, slow };
}

describe('encodeSampleByte / decodeSampleByte', () => {
  it('round-trips every one of the 36 possible combinations', () => {
    for (const dx of [-1, 0, 1] as const) {
      for (const dy of [-1, 0, 1] as const) {
        for (const drawHeld of [false, true]) {
          for (const slow of [false, true]) {
            const s = sample(dx, dy, drawHeld, slow);
            const code = encodeSampleByte(s);
            expect(code).toBeGreaterThanOrEqual(0);
            expect(code).toBeLessThanOrEqual(35);
            expect(decodeSampleByte(code)).toEqual(s);
          }
        }
      }
    }
  });

  it('rejects an out-of-range code', () => {
    expect(() => decodeSampleByte(36)).toThrow();
    expect(() => decodeSampleByte(-1)).toThrow();
    expect(() => decodeSampleByte(1.5)).toThrow();
  });
});

describe('encodeRle / decodeRleToSamples round trip', () => {
  it('round-trips an empty sample list', () => {
    expect(decodeRleToSamples(encodeRle([]))).toEqual([]);
  });

  it('round-trips a mix of repeated and varying samples', () => {
    const samples: InputSample[] = [
      ...Array(50).fill(sample(0, 1, true, false)),
      sample(1, 0, true, true),
      sample(1, 0, true, true),
      sample(0, 0, false, false),
      ...Array(200).fill(sample(-1, -1, true, false)),
    ];
    const rle = encodeRle(samples);
    expect(decodeRleToSamples(rle)).toEqual(samples);
  });

  it('round-trips a long run exceeding a single 7-bit varint byte (multi-byte run length)', () => {
    const samples: InputSample[] = Array(10800).fill(sample(0, 1, true, false));
    const rle = encodeRle(samples);
    // A single (byte, varint) pair should be dramatically smaller than the raw sample count.
    expect(rle.length).toBeLessThan(10);
    expect(decodeRleToSamples(rle)).toEqual(samples);
  });

  it('compresses a long repeated run to far fewer bytes than samples', () => {
    const samples: InputSample[] = Array(1000).fill(sample(1, 0, false, false));
    const rle = encodeRle(samples);
    expect(rle.length).toBeLessThan(20);
  });
});

describe('decodeRleRuns validates while decoding (never materializes first)', () => {
  it('yields one {sample, runLength} per run, matching encodeRle output', () => {
    const samples: InputSample[] = [
      ...Array(5).fill(sample(0, 1, true, false)),
      ...Array(3).fill(sample(1, 0, false, true)),
    ];
    const rle = encodeRle(samples);
    const runs = [...decodeRleRuns(rle, 10800)];
    expect(runs).toEqual([
      { sample: sample(0, 1, true, false), runLength: 5 },
      { sample: sample(1, 0, false, true), runLength: 3 },
    ]);
  });

  it('rejects an invalid sample byte before yielding that run', () => {
    const rle = new Uint8Array([200, 1]); // 200 is not a valid sample code
    expect(() => [...decodeRleRuns(rle, 10800)]).toThrow(/invalid sample code/);
  });

  it('rejects a truncated varint (byte present but its continuation is missing)', () => {
    // A run-length varint byte with the continuation bit set, but no next byte.
    const rle = new Uint8Array([0, 0x80]);
    expect(() => [...decodeRleRuns(rle, 10800)]).toThrow(/truncated varint/);
  });

  it('rejects a zero run length', () => {
    const rle = new Uint8Array([0, 0]);
    expect(() => [...decodeRleRuns(rle, 10800)]).toThrow(/invalid run length/);
  });

  it('rejects a cumulative sample count exceeding maxTotalSamples (the MAX_INPUT_SAMPLES protocol cap)', () => {
    const samples: InputSample[] = Array(101).fill(sample(0, 1, true, false));
    const rle = encodeRle(samples);
    expect(() => [...decodeRleRuns(rle, 100)]).toThrow(/exceeds max sample count/);
  });

  it('a generator consumer sees only validated runs before the exception propagates', () => {
    // Two valid runs followed by a corrupt third run: a caller iterating the
    // generator directly (rather than collecting into an array first) must
    // have already received the two good runs before the throw.
    const goodPart = encodeRle([sample(0, 1, true, false), sample(1, 0, false, true)]);
    const corrupt = new Uint8Array([...goodPart, 255, 1]);
    const seen: unknown[] = [];
    expect(() => {
      for (const run of decodeRleRuns(corrupt, 10800)) {
        seen.push(run);
      }
    }).toThrow();
    expect(seen.length).toBe(2);
  });
});
