// Server-derived duration_ticks for the Free-tier pending-POST path.
// The value is not client-reported or resimulated; the server derives it
// by normalizing and decoding the RLE stream, then counting its samples.
// Deliberately just a
// decode pass — src/core/rle.ts's decodeRleRuns() generator, summing each
// run's length — never a call into verifyReplay()/simulateReplayFromRle().
// This is what keeps POST /api/scores's own structural-verification test
// (functions/_lib/ranking/scoresEndpoint.test.ts's "never invokes
// verifyReplay()" spy) satisfiable: this module imports nothing from
// core/replayEngine or core/session, only core/rle.
//
// Streaming validation still
// applies here even though nothing beyond a byte count is kept: an invalid
// RLE stream throws RleDecodeError partway through, exactly as it would for
// the full validating decode verifyReplay() performs later during the async
// audit — so a malformed replay is rejected at POST time too, just without
// ever being resimulated.
import { decodeRleRuns } from '../../../src/core/rle';
import { MAX_INPUT_SAMPLES } from '../../../src/config';

/** Sums decodeRleRuns()'s run lengths — the total sample count, i.e. the same value verifyReplay()'s resimulation would later report as durationTicks for a *valid* replay that runs to completion without early rejection. Throws RleDecodeError (propagated, uncaught) for a malformed stream. */
export function deriveDurationTicksFromRle(rle: Uint8Array, maxTotalSamples: number = MAX_INPUT_SAMPLES): number {
  let total = 0;
  for (const { runLength } of decodeRleRuns(rle, maxTotalSamples)) {
    total += runLength;
  }
  return total;
}
