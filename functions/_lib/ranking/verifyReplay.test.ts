import { describe, it, expect, vi } from 'vitest';
import { GameSession } from '../../../src/core/session';
import { encodeRle, InputSample } from '../../../src/core/rle';
import { verifyReplay } from './verifyReplay';

const CONFIRM = { dx: 0 as const, dy: 0 as const, drawHeld: false, confirm: true };

/** Records a short, deterministic "wander, then time runs out" replay and returns its RLE bytes. */
function recordTimeUpReplay(seed: number, timeLimitTicks: number): Uint8Array {
  const session = new GameSession({ seed, timeLimitTicks });
  session.update(CONFIRM);
  const samples: InputSample[] = [];
  while (session.getStatus() === 'playing') {
    const input: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
  }
  expect(session.getGameOverReason()).toBe('time');
  return encodeRle(samples);
}

describe('verifyReplay', () => {
  it('accepts a well-formed replay that reaches gameover with no excess input', () => {
    const seed = 4242;
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

    const result = verifyReplay(seed, rle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score).toBe(session.getScore());
      expect(result.stage).toBe(session.getStage());
      expect(result.durationTicks).toBe(session.getTotalTicks());
      expect(result.gameOverReason).toBe(session.getGameOverReason());
    }
  });

  it('is deterministic: verifying the same (seed, rle) twice gives the same result', () => {
    const rle = recordTimeUpReplay(1, 5);
    const a = verifyReplay(1, rle);
    const b = verifyReplay(1, rle);
    expect(a).toEqual(b);
  });

  it('rejects a malformed RLE byte stream', () => {
    const result = verifyReplay(1, new Uint8Array([255, 1]));
    expect(result).toEqual({ ok: false, reason: 'malformed-replay' });
  });

  it('rejects input that never reaches gameover', () => {
    const rle = encodeRle([{ dx: 1, dy: 0, drawHeld: false, slow: false }]);
    const result = verifyReplay(2, rle);
    expect(result).toEqual({ ok: false, reason: 'did-not-reach-gameover' });
  });

  it('rejects a replay with excess input after gameover', () => {
    // Must reach gameover under the *real* production time budget (10800
    // ticks) — verifyReplay() never accepts a custom timeLimitTicks (that's
    // a test-only hook, see core/replayEngine.ts's doc comment), unlike
    // recordTimeUpReplay()'s other call sites above.
    const seed = 4243;
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

    const extra = encodeRle([{ dx: 0, dy: 1, drawHeld: false, slow: false }]);
    const withExcess = new Uint8Array([...encodeRle(samples), ...extra]);
    const result = verifyReplay(seed, withExcess);
    expect(result).toEqual({ ok: false, reason: 'excess-input-after-gameover' });
  });
});

// MAX_VERIFIED_CLAIMS wiring (docs/plans/2026-08-16-score-ranking task 3's
// confirmed spec: "101回目のクレームを検出した時点で即時拒否"). The actual
// early-stop *mechanism* (core/replayEngine.ts's onTick hook, mid-stream
// `break outer`) already has thorough direct coverage in
// src/core/replayEngine.test.ts; constructing a real 101-claim gameplay
// replay here (through actual enemies/collision) would just be a slower,
// more fragile duplicate of that same coverage. This instead verifies
// verifyReplay()'s own mapping from "onTick fired, reachedGameOver: false,
// totalClaims > 100" to the {ok:false, reason:'max-verified-claims-exceeded'}
// result — the piece of logic that's actually specific to this module.
describe('verifyReplay MAX_VERIFIED_CLAIMS mapping', () => {
  it('maps an onTick-triggered stop with totalClaims > 100 to max-verified-claims-exceeded', async () => {
    vi.resetModules();
    vi.doMock('../../../src/core/replayEngine', async () => {
      const actual = await vi.importActual<typeof import('../../../src/core/replayEngine')>('../../../src/core/replayEngine');
      return {
        ...actual,
        simulateReplayFromRle: vi.fn(() => ({
          score: 0,
          stage: 1,
          durationTicks: 101,
          gameOverReason: null,
          totalClaims: 101,
          reachedGameOver: false,
          excessSamplesAfterGameover: 0,
          stageBoundaries: [{ stage: 1, startTick: 0 }],
        })),
      };
    });
    const { verifyReplay: mockedVerifyReplay } = await import('./verifyReplay');
    const result = mockedVerifyReplay(1, new Uint8Array([0, 1]));
    expect(result).toEqual({ ok: false, reason: 'max-verified-claims-exceeded' });
    vi.doUnmock('../../../src/core/replayEngine');
    vi.resetModules();
  });
});
