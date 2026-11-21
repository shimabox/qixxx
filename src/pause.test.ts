import { describe, expect, it } from 'vitest';
import { GameSession, SessionInput } from './core/session';
import { buildStageScript } from './core/scriptedRun';
import { LiveRunTracker, stepLiveSession } from './retryFlow';
import { PauseControl, isPauseKey, type PauseContext } from './pause';

const PLAYING: PauseContext = { live: true, status: 'playing' };

describe('PauseControl', () => {
  it('pauses only a live run that is playing', () => {
    expect(PauseControl.canPause(PLAYING)).toBe(true);
    for (const status of ['title', 'stageclear', 'gameover'] as const) {
      expect(PauseControl.canPause({ live: true, status }), status).toBe(false);
    }
    expect(PauseControl.canPause({ live: false, status: 'playing' })).toBe(false);
  });

  it('a pause request pauses, a resume request resumes', () => {
    const pause = new PauseControl();
    expect(pause.isPaused()).toBe(false);
    expect(pause.requestPause(PLAYING)).toBe(true);
    expect(pause.isPaused()).toBe(true);
    // Already paused: nothing more happens.
    expect(pause.requestPause(PLAYING)).toBe(false);
    expect(pause.isPaused()).toBe(true);
    expect(pause.requestResume()).toBe(true);
    expect(pause.isPaused()).toBe(false);
    expect(pause.requestResume()).toBe(false);
  });

  it('ignores a pause request where the run cannot be paused', () => {
    const pause = new PauseControl();
    for (const ctx of [
      { live: true, status: 'title' },
      { live: true, status: 'stageclear' },
      { live: true, status: 'gameover' },
      { live: false, status: 'playing' },
    ] as const) {
      expect(pause.requestPause(ctx)).toBe(false);
      expect(pause.toggle(ctx)).toBeNull();
      expect(pause.isPaused()).toBe(false);
    }
  });

  it('toggles between paused and playing', () => {
    const pause = new PauseControl();
    expect(pause.toggle(PLAYING)).toBe('paused');
    expect(pause.toggle(PLAYING)).toBe('resumed');
    expect(pause.toggle(PLAYING)).toBe('paused');
  });

  it('steps the run only while not paused', () => {
    const pause = new PauseControl();
    expect(pause.shouldStep()).toBe(true);
    pause.requestPause(PLAYING);
    expect(pause.shouldStep()).toBe(false);
    pause.requestResume();
    expect(pause.shouldStep()).toBe(true);
  });

  describe('keys', () => {
    it('P and Escape are the pause keys', () => {
      expect(isPauseKey('KeyP')).toBe(true);
      expect(isPauseKey('Escape')).toBe(true);
      expect(isPauseKey('Space')).toBe(false);
      expect(isPauseKey('Enter')).toBe(false);
    });

    it('a new press toggles; holding the key (auto-repeat) does not toggle again', () => {
      const pause = new PauseControl();
      expect(pause.keyDown('KeyP', false, PLAYING)).toBe('paused');
      // Auto-repeat, flagged or not, while the key stays down.
      expect(pause.keyDown('KeyP', true, PLAYING)).toBeNull();
      expect(pause.keyDown('KeyP', false, PLAYING)).toBeNull();
      expect(pause.isPaused()).toBe(true);
      pause.keyUp('KeyP');
      expect(pause.keyDown('KeyP', false, PLAYING)).toBe('resumed');
      pause.keyUp('KeyP');
      expect(pause.keyDown('Escape', false, PLAYING)).toBe('paused');
      pause.keyUp('Escape');
      expect(pause.keyDown('Escape', false, PLAYING)).toBe('resumed');
    });

    it('other keys and other screens leave the pause alone', () => {
      const pause = new PauseControl();
      expect(pause.keyDown('Space', false, PLAYING)).toBeNull();
      expect(pause.keyDown('KeyP', false, { live: true, status: 'title' })).toBeNull();
      expect(pause.isPaused()).toBe(false);
    });

    it('keeps the pause keys from the game only where they pause or resume', () => {
      const pause = new PauseControl();
      expect(pause.consumesKey('KeyP', PLAYING)).toBe(true);
      expect(pause.consumesKey('Escape', PLAYING)).toBe(true);
      expect(pause.consumesKey('ArrowRight', PLAYING)).toBe(false);
      // On Title, GAME OVER and in a replay, P / Escape work as any other key.
      expect(pause.consumesKey('KeyP', { live: true, status: 'title' })).toBe(false);
      expect(pause.consumesKey('Escape', { live: true, status: 'gameover' })).toBe(false);
      expect(pause.consumesKey('KeyP', { live: false, status: 'playing' })).toBe(false);
      pause.requestPause(PLAYING);
      expect(pause.consumesKey('KeyP', PLAYING)).toBe(true);
    });
  });
});

// ---- A paused run records the same inputs as an unpaused one ---------------

// src/ is type-checked on its own (tsconfig rootDir ./src), so the server
// module is loaded by a runtime path the compiler does not follow. The test
// still runs the real functions/_lib/ranking/verifyReplay.ts.
const VERIFY_REPLAY_MODULE = '../functions/_lib/ranking/verifyReplay';
type VerifyReplay = (
  seed: number,
  rle: Uint8Array
) => { ok: true; score: number; stage: number; durationTicks: number } | { ok: false; reason: string };

async function loadVerifyReplay(): Promise<VerifyReplay> {
  const mod = (await import(/* @vite-ignore */ VERIFY_REPLAY_MODULE)) as { verifyReplay: VerifyReplay };
  return mod.verifyReplay;
}

const IDLE: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };

/**
 * main.ts's live loop minus the DOM: every frame either runs one tick (read
 * the held input, step the session, record) or, while paused, nothing at all.
 * The "keyboard" is whatever input the script holds at the frame.
 */
class PausableDriver {
  readonly tracker = new LiveRunTracker();
  readonly pause = new PauseControl();
  constructor(readonly session: GameSession) {}

  frame(held: SessionInput): void {
    if (!this.pause.shouldStep()) return;
    stepLiveSession(this.session, held, { retry: true, onFreshRun: () => this.tracker.startFreshRun() });
    this.tracker.observe(this.session, held, this.session.drainEvents());
    this.session.drainDespawnedEmberPositions();
  }

  ctx(): PauseContext {
    return { live: true, status: this.session.getStatus() };
  }
}

function scriptInput(script: ReturnType<typeof buildStageScript>, tick: number): SessionInput {
  let remaining = tick;
  for (const s of script) {
    if (remaining < s.ticks) return { dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false };
    remaining -= s.ticks;
  }
  return IDLE;
}

/**
 * Plays the scripted stages until GAME OVER. `pauseAt` lists the stage ticks
 * to pause on: each pause lasts 300 frames, during which the player holds
 * and lets go of arrows (inputs the run never reads), then resumes.
 */
function playToGameOver(driver: PausableDriver, pauseAt: number[]): number {
  const session = driver.session;
  const field = session.getGame().getField();
  const script = buildStageScript(field.getWidth(), field.getHeight());
  const pending = [...pauseAt];
  let pauses = 0;
  let guard = 0;
  driver.frame({ ...IDLE, confirm: true });
  while (session.getStatus() !== 'gameover') {
    if (guard++ > 40000) throw new Error('run did not end');
    if (session.getStatus() === 'stageclear') {
      driver.frame({ ...IDLE, confirm: true });
      continue;
    }
    if (pending.length > 0 && session.getTotalTicks() >= pending[0] && session.getStatus() === 'playing') {
      pending.shift();
      expect(driver.pause.requestPause(driver.ctx())).toBe(true);
      const before = { ticks: session.getTotalTicks(), score: session.getScore(), samples: driver.tracker.recorder.getSamples().length };
      for (let f = 0; f < 300; f++) {
        driver.frame(f % 50 < 25 ? { ...IDLE, dx: 1, drawHeld: true } : { ...IDLE, dy: -1 });
      }
      expect({ ticks: session.getTotalTicks(), score: session.getScore(), samples: driver.tracker.recorder.getSamples().length }).toEqual(before);
      expect(session.getStatus()).toBe('playing');
      expect(driver.pause.requestResume()).toBe(true);
      pauses++;
    }
    driver.frame(scriptInput(script, session.getStageTicks()));
  }
  return pauses;
}

describe('a run paused along the way', () => {
  it('records the same inputs as the unpaused run, which the server verifier accepts with the same score and stage', async () => {
    const verifyReplay = await loadVerifyReplay();
    // A seed whose scripted run lasts past every pause below (3180 ticks).
    const seed = 542;

    const plain = new PausableDriver(new GameSession({ seed, captureFeedback: true }));
    expect(playToGameOver(plain, [])).toBe(0);

    const paused = new PausableDriver(new GameSession({ seed, captureFeedback: true }));
    expect(playToGameOver(paused, [120, 900, 2500])).toBe(3);

    expect(paused.tracker.recorder.getSamples()).toEqual(plain.tracker.recorder.getSamples());
    expect(paused.session.getScore()).toBe(plain.session.getScore());
    expect(paused.session.getStage()).toBe(plain.session.getStage());
    expect(paused.session.getTotalTicks()).toBe(plain.session.getTotalTicks());
    expect(paused.tracker.getClaims()).toBe(plain.tracker.getClaims());
    expect(paused.tracker.getClaims()).toBeGreaterThan(0);

    const verdict = verifyReplay(seed, paused.tracker.recorder.encode());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.score).toBe(paused.session.getScore());
    expect(verdict.stage).toBe(paused.session.getStage());
    expect(verdict.durationTicks).toBe(paused.session.getTotalTicks());
  }, 30_000);
});
