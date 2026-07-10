// Pure request-body validation for POST /qixxx/share
// (docs/plan-cloudflare-x-share.md Phase 2's three checks: this module
// covers the "shape" checks and the theoretical-max check; Origin and rate
// limiting are handled in share.ts itself since they need the Request/KV,
// which this module deliberately stays free of so it's trivially unit
// -testable).
import type { ShareRequestPayload } from './types';
import { maxScoreForStage } from './scoreLimits';

export type ShareValidationResult =
  | { kind: 'ok'; value: ShareRequestPayload }
  // Malformed/wrong-shaped body -> share.ts maps this to HTTP 400.
  | { kind: 'malformed'; reason: string }
  // Well-shaped but score exceeds maxScoreForStage(stage) -> HTTP 422
  // (docs/plan-cloudflare-x-share.md Phase 2's "理論上限チェック").
  | { kind: 'exceeds-max'; reason: string };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Validates a decoded JSON body against the {score, stage, hi} shape the
 * client sends (src/ui/gameOverModal.ts). All three fields must be
 * non-negative integers, stage must additionally be >= 1, and hi must be >=
 * score — the client always computes hi as `Math.max(highScore,
 * currentScore)` (src/core/session.ts's getHighScore()), so a genuine
 * request can never violate this; it's a cheap extra consistency check on
 * top of the Origin/rate-limit/theoretical-max defenses.
 */
export function validateSharePayload(body: unknown): ShareValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'malformed', reason: 'body must be a JSON object' };
  }
  const { score, stage, hi } = body as Record<string, unknown>;

  if (!isNonNegativeInteger(score)) {
    return { kind: 'malformed', reason: 'score must be a non-negative integer' };
  }
  if (!isNonNegativeInteger(stage) || stage < 1) {
    return { kind: 'malformed', reason: 'stage must be an integer >= 1' };
  }
  if (!isNonNegativeInteger(hi)) {
    return { kind: 'malformed', reason: 'hi must be a non-negative integer' };
  }
  if (hi < score) {
    return { kind: 'malformed', reason: 'hi must be >= score' };
  }

  const ceiling = maxScoreForStage(stage);
  if (score > ceiling) {
    return { kind: 'exceeds-max', reason: `score exceeds theoretical max (${ceiling}) for stage ${stage}` };
  }

  return { kind: 'ok', value: { score, stage, hi } };
}
