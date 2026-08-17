import { describe, it, expect } from 'vitest';
import { GameSession } from '../../../src/core/session';
import { Axis } from '../../../src/core/marker';
import { encodeRle, InputSample } from '../../../src/core/rle';
import { MAX_VERIFIED_CLAIMS } from '../../../src/config';
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

// MAX_VERIFIED_CLAIMS (docs/plans/2026-08-16-score-ranking task 3's confirmed
// spec: "101回目のクレームを検出した時点で即時拒否"; task 5: "投稿可否に影響
// するプロトコルパラメータであるためテスト対象とすること").
//
// Driven through the real, shipped wiring — a genuine input stream fed to the
// real verifyReplay(), which resimulates it with the production core: real
// stage-1 enemies, real collision, real claim accounting, and the real onTick
// early-stop. Nothing is substituted or mocked, so this exercises the same
// path a hostile POST would actually take.
//
// The input stream is generated here rather than checked in as a blob: a bot
// that walks the two permanent BORDER rows and cuts a shallow, near-zero-area
// notch at each of a series of non-overlapping columns. Each closed notch
// fires exactly one 'area-claimed' event (core/game.ts pushes it whenever a
// line closes, however little area it encloses), so claim count is a direct
// function of how many notches are cut — the same construction the task-1 CPU
// spike's B-success/B-rejected fixtures used, minus their neutralized-enemy
// bench factory, which turns out to be unnecessary: the notches are shallow
// enough that the marker survives with all three lives at every seed tried.
type ClaimBotResult = { rle: Uint8Array; claims: number };

function recordNotchClaims(seed: number, targetClaims: number): ClaimBotResult {
  const session = new GameSession({ seed });
  session.update(CONFIRM); // Title -> Playing
  const field = session.getGame().getField();
  const width = field.getWidth();
  const height = field.getHeight();
  const samples: InputSample[] = [];
  let claims = 0;

  function push(dx: Axis, dy: Axis, drawHeld: boolean): void {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    for (const event of session.drainEvents()) if (event === 'area-claimed') claims++;
    session.drainDespawnedEmberPositions(); // keep the session's queues from growing unbounded
  }

  const notchDepth = 4;
  const pitch = 3; // >= notchWidth + 2, so consecutive notches never share/touch a column
  const bandLo = 2;
  const slotsPerRow = Math.floor((width - 3 - bandLo) / pitch);
  const rows = [0, height - 1] as const;
  let slot = 0;
  let guard = 0;

  while (claims < targetClaims && session.getStatus() === 'playing' && guard++ < 40_000) {
    if (slot >= slotsPerRow * rows.length) break;
    const row = rows[Math.floor(slot / slotsPerRow)];
    const col = bandLo + (slot % slotsPerRow) * pitch;
    const dive: Axis = row === 0 ? 1 : -1;
    slot++;

    // Route to this notch's row via a side column (x=0 / width-1) — the only
    // BORDER cells joining the two permanent rows — never through the field.
    let pos = session.getGame().getMarker().getPosition();
    if (pos.y !== row) {
      const sideX = pos.x < width / 2 ? 0 : width - 1;
      while (pos.x !== sideX && session.getStatus() === 'playing') {
        push(pos.x < sideX ? 1 : -1, 0, false);
        pos = session.getGame().getMarker().getPosition();
      }
      while (pos.y !== row && session.getStatus() === 'playing') {
        push(0, pos.y < row ? 1 : -1, false);
        pos = session.getGame().getMarker().getPosition();
      }
    }
    while (pos.x !== col && session.getStatus() === 'playing') {
      push(pos.x < col ? 1 : -1, 0, false);
      pos = session.getGame().getMarker().getPosition();
    }

    // Dive in, step across, come back out: closes on reaching the row again.
    for (let i = 0; i < notchDepth; i++) push(0, dive, true);
    push(1, 0, true);
    for (let i = 0; i < notchDepth + 1; i++) {
      if (session.getGame().getMarker().getPosition().y === row) break;
      push(0, (-dive) as Axis, true);
    }
  }

  return { rle: encodeRle(samples), claims };
}

describe('verifyReplay MAX_VERIFIED_CLAIMS (real simulation, no mocks)', () => {
  it('is pinned at 100', () => {
    // Guards the test below against a silent config change: the numbers it
    // builds (100 / 101 claims) only mean what they say at this value.
    expect(MAX_VERIFIED_CLAIMS).toBe(100);
  });

  it('rejects a replay whose 101st claim is reached, through the production verifyReplay path', () => {
    const seed = 424242;
    const { rle, claims } = recordNotchClaims(seed, MAX_VERIFIED_CLAIMS + 1);
    expect(claims).toBe(MAX_VERIFIED_CLAIMS + 1); // the bot really did produce 101 real claims

    expect(verifyReplay(seed, rle)).toEqual({ ok: false, reason: 'max-verified-claims-exceeded' });
  });

  it('does NOT invoke the claim cap at exactly 100 claims (the boundary is the 101st, not the 100th)', () => {
    const seed = 424242;
    const { rle, claims } = recordNotchClaims(seed, MAX_VERIFIED_CLAIMS);
    expect(claims).toBe(MAX_VERIFIED_CLAIMS);

    // This stream stops right after the 100th claim, so it never reaches a
    // gameover — the point is only that it is rejected for *that* reason and
    // not for the claim cap.
    expect(verifyReplay(seed, rle)).toEqual({ ok: false, reason: 'did-not-reach-gameover' });
  });

  it('rejects at the cap for several different seeds (not a single-board coincidence)', () => {
    for (const seed of [1, 7, 99]) {
      const { rle, claims } = recordNotchClaims(seed, MAX_VERIFIED_CLAIMS + 1);
      expect(claims).toBe(MAX_VERIFIED_CLAIMS + 1);
      expect(verifyReplay(seed, rle)).toEqual({ ok: false, reason: 'max-verified-claims-exceeded' });
    }
  });
});
