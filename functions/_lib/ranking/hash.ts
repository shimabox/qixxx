// replay_hash computation (docs/plans/2026-08-16-score-ranking task 3's
// confirmed spec): computed from season + rulesetVersion + seed +
// *normalized* input list — never the raw received BLOB — so re-submitting
// the same logical run RLE-split a different way can't slip past the
// `replay_hash UNIQUE` constraint (migrations/0001_create_scores.sql).
// "Normalized" means: decode the received bytes into samples, then
// re-encode them through this codebase's own canonical encodeRle() — a
// pure, deterministic function, so any two byte streams that decode to the
// same sample sequence always re-encode to byte-identical output.
//
// Residual risk (documented per task 3's requirement): this defends only
// against *equivalent re-encodings* of the same input list. It does not
// (and cannot) prevent a bot-generated input list, nor a public replay's
// input list being fetched and resubmitted with a handful of cells nudged
// (a genuinely different, if RLE-adjacent, sample sequence hashes
// differently and would be accepted as a "new" run). This is a known,
// accepted v1 limitation — see this feature's request.md task 3.
import { decodeRleToSamples, encodeRle } from '../../../src/core/rle';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export interface ReplayHashInput {
  seasonId: number;
  rulesetVersion: number;
  seed: number;
  rle: Uint8Array;
}

/** SHA-256 hex digest of `seasonId:rulesetVersion:seed:` followed by the canonically re-encoded RLE bytes. */
export async function computeReplayHash(input: ReplayHashInput): Promise<string> {
  const canonicalRle = encodeRle(decodeRleToSamples(input.rle));
  const header = new TextEncoder().encode(`${input.seasonId}:${input.rulesetVersion}:${input.seed}:`);
  const combined = new Uint8Array(header.length + canonicalRle.length);
  combined.set(header, 0);
  combined.set(canonicalRle, header.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return bytesToHex(new Uint8Array(digest));
}
