// RLE codec for a recorded input stream. Pure logic with no DOM,
// localStorage, or fetch dependency, matching every other module in src/core/.
//
// Encoding: each PLAYING-tick input sample (dx, dy, drawHeld, slow) packs
// into one byte (36 possible combinations, well under 256), followed by a
// LEB128 varint run-length. `decodeRleRuns()` is a generator that decodes
// and validates one run at a time — never materializing the full expanded
// sample array — per the streaming-validation rule (RLE must be
// validated *while* decoding, not decoded-then-validated).
import { Axis } from './marker';
import { MAX_INPUT_SAMPLES } from '../config';

export interface InputSample {
  dx: Axis;
  dy: Axis;
  drawHeld: boolean;
  slow: boolean;
}

/**
 * Thrown for every decode-time validation failure in this module (an invalid
 * sample byte, a truncated/over-long varint, an invalid run length, or a
 * cumulative sample count past the configured cap).
 *
 * Introduced (replacing this module's previous plain `Error` throws) so that
 * functions/_lib/ranking/verifyReplay.ts can catch *specifically* an RLE
 * decode failure and continue converting it to its existing
 * `{ok:false, reason:'malformed-replay'}` return value, while letting any
 * OTHER, genuinely-unexpected exception (e.g. from deep inside GameSession)
 * propagate instead of being silently folded into "malformed replay" too.
 * Kept as a single class (no error-code enum) — nothing downstream branches
 * on which specific decode failure occurred, only on "was it an RLE decode
 * failure at all", so a code enum would be unused surface, not safety.
 */
export class RleDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RleDecodeError';
  }
}

const AXIS_VALUES: readonly Axis[] = [-1, 0, 1];

/** Packs one sample into a single byte in [0, 35]. */
export function encodeSampleByte(s: InputSample): number {
  const dxIdx = AXIS_VALUES.indexOf(s.dx);
  const dyIdx = AXIS_VALUES.indexOf(s.dy);
  return dxIdx * 12 + dyIdx * 4 + (s.drawHeld ? 2 : 0) + (s.slow ? 1 : 0);
}

/** Unpacks a single byte back into a sample. Throws RleDecodeError on any value outside [0, 35] (an invalid/corrupt code). */
export function decodeSampleByte(code: number): InputSample {
  if (!Number.isInteger(code) || code < 0 || code > 35) {
    throw new RleDecodeError(`rle: invalid sample code ${code}`);
  }
  const dxIdx = Math.floor(code / 12);
  const rem1 = code % 12;
  const dyIdx = Math.floor(rem1 / 4);
  const rem2 = rem1 % 4;
  return {
    dx: AXIS_VALUES[dxIdx],
    dy: AXIS_VALUES[dyIdx],
    drawHeld: (rem2 & 2) !== 0,
    slow: (rem2 & 1) !== 0,
  };
}

/**
 * Hard cap on how many bytes one run-length varint may occupy.
 *
 * A run length in this format is always in [1, MAX_INPUT_SAMPLES] (10800 —
 * two varint bytes), so 5 bytes (a full uint32 and then some) is already
 * absurdly generous headroom for any *legitimate* payload. The cap exists as
 * a safety bound, not a convenience one: without it, a crafted run of
 * continuation bytes (0x80 ...) drives `shift` arbitrarily high, at which
 * point `Math.pow(2, shift)` becomes `Infinity` and `0 * Infinity` is `NaN`.
 * `NaN` then silently passes *both* `runLength <= 0` and
 * `total > maxTotalSamples` (every comparison against NaN is false), letting
 * an unvalidated run escape the decoder — exactly the kind of
 * "validate-while-decoding" hole this module's contract forbids. The cap plus
 * the `Number.isSafeInteger()` check below closes it from both directions.
 */
const MAX_VARINT_BYTES = 5;

function writeVarint(bytes: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
}

/** Encodes a full sample list as (byte, varint run-length) pairs. */
export function encodeRle(samples: readonly InputSample[]): Uint8Array {
  const bytes: number[] = [];
  let i = 0;
  while (i < samples.length) {
    const code = encodeSampleByte(samples[i]);
    let runLength = 1;
    while (i + runLength < samples.length && encodeSampleByte(samples[i + runLength]) === code) {
      runLength++;
    }
    bytes.push(code);
    writeVarint(bytes, runLength);
    i += runLength;
  }
  return new Uint8Array(bytes);
}

/**
 * Decodes+validates `data` one run at a time, yielding
 * `{ sample, runLength }` — never materializing the fully-expanded sample
 * array (see this module's doc comment). Throws as soon as it encounters an
 * invalid sample byte, a truncated or over-long varint, a run length that
 * isn't a positive safe integer, or a cumulative sample count exceeding
 * `maxTotalSamples` — a caller mid-way
 * through consuming the generator has therefore only ever processed
 * *validated* runs by the time an exception propagates.
 */
export function* decodeRleRuns(
  data: Uint8Array,
  maxTotalSamples: number = MAX_INPUT_SAMPLES
): Generator<{ sample: InputSample; runLength: number }> {
  let offset = 0;
  let total = 0;
  while (offset < data.length) {
    const code = data[offset];
    offset++;
    const sample = decodeSampleByte(code); // throws before this run is ever used

    let runLength = 0;
    let shift = 0;
    let varintBytes = 0;
    let byte: number;
    do {
      if (offset >= data.length) throw new RleDecodeError('rle: truncated varint');
      if (varintBytes >= MAX_VARINT_BYTES) throw new RleDecodeError(`rle: varint exceeds ${MAX_VARINT_BYTES} bytes`);
      byte = data[offset];
      offset++;
      varintBytes++;
      runLength += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (byte & 0x80);

    // `Number.isSafeInteger()` — not a bare `runLength <= 0` — because that
    // comparison alone is false for NaN and for Infinity, the two values a
    // malformed varint can otherwise produce (see MAX_VARINT_BYTES). This
    // rejects NaN, ±Infinity, and any non-integer outright; MAX_VARINT_BYTES
    // caps `shift` at 28, so a well-formed varint here is always exact.
    if (!Number.isSafeInteger(runLength) || runLength <= 0) {
      throw new RleDecodeError(`rle: invalid run length ${runLength}`);
    }
    total += runLength;
    if (total > maxTotalSamples) throw new RleDecodeError(`rle: exceeds max sample count (${maxTotalSamples})`);

    yield { sample, runLength };
  }
}

/**
 * Convenience wrapper over decodeRleRuns() that *does* materialize the full
 * sample array — for callers (tests, the UI's replay list fetch) that need
 * random access rather than a streaming pass. Server-side verification
 * (functions/_lib/verifyReplay.ts) uses decodeRleRuns() directly instead, to
 * honor the "検証しながら展開" rule all the way through a 10800-sample replay.
 */
export function decodeRleToSamples(data: Uint8Array, maxTotalSamples: number = MAX_INPUT_SAMPLES): InputSample[] {
  const samples: InputSample[] = [];
  for (const { sample, runLength } of decodeRleRuns(data, maxTotalSamples)) {
    for (let i = 0; i < runLength; i++) samples.push(sample);
  }
  return samples;
}
