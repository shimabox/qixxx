// verifyPendingEntry()
// is the async-audit-side layer that classifies BOTH verifyReplay()'s own
// `{ok:false,...}` results AND a declared-value/version mismatch as
// "confirmed invalid" — while never catching anything verifyReplay() itself
// doesn't (an unexpected exception must still propagate out of this
// function too, for the caller to route to the retry path).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GameSession } from '../../../src/core/session';
import { encodeRle, InputSample } from '../../../src/core/rle';
import { verifyReplay } from './verifyReplay';
import { verifyPendingEntry } from './verifyPendingEntry';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../../src/config';

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIRM = { dx: 0 as const, dy: 0 as const, drawHeld: false, confirm: true };

/** An arbitrary "current" season for these pure unit tests — deliberately not season.ts's real CURRENT_SEASON_ID, which is free to move. */
const SEASON_ID = 3;

/** A short, real, gameover-reaching replay — mirrors verifyReplay.test.ts's own fixture construction. */
function recordRealReplay(seed: number): { rle: Uint8Array; score: number; stage: number; durationTicks: number } {
  const session = new GameSession({ seed });
  session.update(CONFIRM);
  const samples: InputSample[] = [];
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard < 20000) {
    const input: InputSample = { dx: 0, dy: 1, drawHeld: true, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
    guard++;
  }
  expect(session.getStatus()).toBe('gameover');
  const rle = encodeRle(samples);
  const verified = verifyReplay(seed, rle);
  if (!verified.ok) throw new Error('fixture setup failed: expected an accepted replay');
  return { rle, score: verified.score, stage: verified.stage, durationTicks: verified.durationTicks };
}

describe('verifyPendingEntry', () => {
  it('accepts when declared score/stage/duration/version all match a real resimulation', () => {
    const seed = 5150;
    const fixture = recordRealReplay(seed);
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score,
      declaredStage: fixture.stage,
      declaredDurationTicks: fixture.durationTicks,
      declaredRulesetVersion: RULESET_VERSION,
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({
      ok: true,
      score: fixture.score,
      stage: fixture.stage,
      durationTicks: fixture.durationTicks,
      totalClaims: expect.any(Number),
      gameOverReason: expect.any(String),
    });
  });

  it('propagates verifyReplay()\'s own malformed-replay rejection unchanged (RleDecodeError absorbed inside verifyReplay(), never re-surfaced here)', () => {
    const result = verifyPendingEntry({
      seed: 1,
      rle: new Uint8Array([255, 1]),
      declaredScore: 0,
      declaredStage: 1,
      declaredDurationTicks: 0,
      declaredRulesetVersion: RULESET_VERSION,
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-replay' });
  });

  it('rejects a declared score that does not match the resimulated score', () => {
    const seed = 5151;
    const fixture = recordRealReplay(seed);
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score + 1, // forged
      declaredStage: fixture.stage,
      declaredDurationTicks: fixture.durationTicks,
      declaredRulesetVersion: RULESET_VERSION,
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'declared-score-mismatch' });
  });

  it('rejects a declared stage that does not match', () => {
    const seed = 5152;
    const fixture = recordRealReplay(seed);
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score,
      declaredStage: fixture.stage + 1,
      declaredDurationTicks: fixture.durationTicks,
      declaredRulesetVersion: RULESET_VERSION,
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'declared-stage-mismatch' });
  });

  it('rejects a declared duration that does not match', () => {
    const seed = 5153;
    const fixture = recordRealReplay(seed);
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score,
      declaredStage: fixture.stage,
      declaredDurationTicks: fixture.durationTicks + 1,
      declaredRulesetVersion: RULESET_VERSION,
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'declared-duration-mismatch' });
  });

  // A season bump with RULESET_VERSION deliberately
  // left unchanged (season.ts documents that as the supported "reset the
  // ranking" operation) used to slip past the version checks entirely, so an
  // old season's pending row got CONFIRMED as verified — into a season no
  // ranking query ever reads and the TOP10 cleanup never trims.
  it("rejects a season_id that no longer matches the server's current season, even with an otherwise perfect, current-ruleset replay (without resimulating at all)", async () => {
    const seed = 5156;
    const fixture = recordRealReplay(seed);
    // Spied AFTER the fixture is recorded (recordRealReplay() calls
    // verifyReplay() itself), so the call count below is verifyPendingEntry()'s
    // alone.
    const verifyReplaySpy = vi.spyOn(await import('./verifyReplay'), 'verifyReplay');
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score,
      declaredStage: fixture.stage,
      declaredDurationTicks: fixture.durationTicks,
      declaredRulesetVersion: RULESET_VERSION, // current — the ruleset check alone would let this row through
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID - 1, // last season
      expectedSeasonId: SEASON_ID,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
    });
    expect(result).toEqual({ ok: false, reason: 'season-mismatch' });
    expect(verifyReplaySpy).not.toHaveBeenCalled(); // classified before (and instead of) any resimulation
  });

  it('rejects a ruleset_version that no longer matches the server\'s current value (without resimulating at all)', () => {
    const seed = 5154;
    const fixture = recordRealReplay(seed);
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score,
      declaredStage: fixture.stage,
      declaredDurationTicks: fixture.durationTicks,
      declaredRulesetVersion: RULESET_VERSION - 1, // stale
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'ruleset-version-mismatch' });
  });

  it('rejects a replay_format_version that no longer matches', () => {
    const seed = 5155;
    const fixture = recordRealReplay(seed);
    const result = verifyPendingEntry({
      seed,
      rle: fixture.rle,
      declaredScore: fixture.score,
      declaredStage: fixture.stage,
      declaredDurationTicks: fixture.durationTicks,
      declaredRulesetVersion: RULESET_VERSION,
      declaredReplayFormatVersion: REPLAY_FORMAT_VERSION - 1, // stale
      expectedRulesetVersion: RULESET_VERSION,
      expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
      declaredSeasonId: SEASON_ID,
      expectedSeasonId: SEASON_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'replay-format-version-mismatch' });
  });

  it('propagates a genuinely unexpected (non-RleDecodeError) exception from verifyReplay() rather than classifying it as a confirmed mismatch', async () => {
    // verifyPendingEntry() has no try/catch of its own (see its module
    // comment) — anything verifyReplay() itself doesn't convert to a
    // VerifyReplayResult must propagate unchanged, so the audit script's
    // caller can route it to the audit_attempts/next_attempt_at retry path
    // instead of treating it as "confirmed invalid, delete immediately".
    // Simulated by mocking verifyReplay() to throw a plain, non-RleDecodeError
    // Error — standing in for e.g. a genuine bug deep inside GameSession.
    const verifyModule = await import('./verifyReplay');
    const boom = new Error('unexpected: something inside the simulator broke');
    vi.spyOn(verifyModule, 'verifyReplay').mockImplementation(() => {
      throw boom;
    });
    expect(() =>
      verifyPendingEntry({
        seed: 1,
        rle: new Uint8Array([0, 1]),
        declaredScore: 0,
        declaredStage: 1,
        declaredDurationTicks: 1,
        declaredRulesetVersion: RULESET_VERSION,
        declaredReplayFormatVersion: REPLAY_FORMAT_VERSION,
        expectedRulesetVersion: RULESET_VERSION,
        expectedReplayFormatVersion: REPLAY_FORMAT_VERSION,
        declaredSeasonId: SEASON_ID,
        expectedSeasonId: SEASON_ID,
      })
    ).toThrow(boom);
  });
});
