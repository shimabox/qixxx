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

  it('rejects an over-long varint that would otherwise decode to NaN (the 0 * Infinity hole)', () => {
    // Regression test for a real slip-through: with an unbounded `shift`,
    // 200 continuation bytes push `Math.pow(2, shift)` to Infinity, and
    // `(0x80 & 0x7f) * Infinity` is `0 * Infinity` === NaN. NaN then passes
    // *both* `runLength <= 0` and the `total > maxTotalSamples` cap (every
    // comparison against NaN is false), so the run used to be yielded
    // unvalidated. It must now be rejected outright.
    const nanPayload = new Uint8Array([0, ...Array(200).fill(0x80), 0x01]);
    expect(() => [...decodeRleRuns(nanPayload, 10800)]).toThrow(/varint exceeds/);

    // Same shape, but terminating on a zero byte — the variant whose decoded
    // value is NaN rather than Infinity all the way through.
    const nanPayloadZeroTerminated = new Uint8Array([0, ...Array(200).fill(0x80), 0x00]);
    expect(() => [...decodeRleRuns(nanPayloadZeroTerminated, 10800)]).toThrow(/varint exceeds/);
  });

  it('rejects a varint one byte past the cap, even though it decodes to an ordinary finite number', () => {
    // Six varint bytes: well within Number range (no NaN/Infinity involved),
    // but still past the 5-byte protocol cap — the bound is enforced on the
    // encoding, not merely on the value it happens to produce.
    const sixByteVarint = new Uint8Array([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(() => [...decodeRleRuns(sixByteVarint, Number.MAX_SAFE_INTEGER)]).toThrow(/varint exceeds/);
  });

  it('never yields a run length that is not a positive safe integer, for any malformed payload', () => {
    // A blanket property check over the malformed shapes above plus a few
    // more: whatever a payload does, a yielded runLength is always a
    // finite, positive, exact integer — never NaN, Infinity, or fractional.
    const malformed: Uint8Array[] = [
      new Uint8Array([0, ...Array(200).fill(0x80), 0x01]),
      new Uint8Array([0, ...Array(64).fill(0x80), 0x7f]),
      new Uint8Array([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f]),
      new Uint8Array([0, 0xff, 0xff, 0xff, 0xff, 0x7f]),
      new Uint8Array([0, 0]),
      new Uint8Array([0, 0x80]),
    ];
    for (const data of malformed) {
      try {
        for (const { runLength } of decodeRleRuns(data, 10800)) {
          expect(Number.isSafeInteger(runLength)).toBe(true);
          expect(runLength).toBeGreaterThan(0);
        }
      } catch {
        // Throwing is the expected outcome for most of these — the point of
        // this test is that nothing bogus is *yielded* on the way there.
      }
    }
  });

  it('still accepts a maximum-length legitimate run (10800 samples, a 2-byte varint)', () => {
    const samples: InputSample[] = Array(10800).fill(sample(0, 1, true, false));
    const runs = [...decodeRleRuns(encodeRle(samples), 10800)];
    expect(runs).toEqual([{ sample: sample(0, 1, true, false), runLength: 10800 }]);
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
