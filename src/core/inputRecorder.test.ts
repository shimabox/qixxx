import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { InputRecorder, TickSource } from './inputRecorder';

describe('InputRecorder', () => {
  it('records exactly one sample per new playing tick, in order', () => {
    const session = new GameSession({ seed: 1 });
    const recorder = new InputRecorder();

    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // Title -> Playing (not a playing tick itself)
    recorder.observe(session, { dx: 0, dy: 0, drawHeld: false });
    expect(recorder.getSamples()).toEqual([]); // confirm-into-playing tick isn't itself a playing tick

    session.update({ dx: 1, dy: 0, drawHeld: false, confirm: false });
    recorder.observe(session, { dx: 1, dy: 0, drawHeld: false });
    session.update({ dx: 0, dy: -1, drawHeld: true, confirm: false, slow: true });
    recorder.observe(session, { dx: 0, dy: -1, drawHeld: true, slow: true });

    expect(recorder.getSamples()).toEqual([
      { dx: 1, dy: 0, drawHeld: false, slow: false },
      { dx: 0, dy: -1, drawHeld: true, slow: true },
    ]);
  });

  it('does not record while the session is not in "playing" (title/stageclear/gameover confirm ticks)', () => {
    const session = new GameSession({ seed: 2, timeLimitTicks: 2 });
    const recorder = new InputRecorder();

    // Title: confirm, no playing tick yet.
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    recorder.observe(session, { dx: 0, dy: 0, drawHeld: false });
    // 2 playing ticks burn the tiny time budget down to a time-up gameover.
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    recorder.observe(session, { dx: 0, dy: 0, drawHeld: false });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: false });
    recorder.observe(session, { dx: 0, dy: 0, drawHeld: false });
    expect(session.getStatus()).toBe('gameover');

    // Further "confirm" ticks (gameover -> title) must not be recorded even
    // though drawHeld/dx/dy happen to be passed alongside confirm — the
    // recorder only ever looks at whether a playing tick actually advanced.
    session.update({ dx: 1, dy: 1, drawHeld: true, confirm: true });
    recorder.observe(session, { dx: 1, dy: 1, drawHeld: true });

    expect(recorder.getSamples()).toEqual([
      { dx: 0, dy: 0, drawHeld: false, slow: false },
      { dx: 0, dy: 0, drawHeld: false, slow: false },
    ]);
  });

  it('reset() clears every recorded sample', () => {
    const session = new GameSession({ seed: 3 });
    const recorder = new InputRecorder();
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    session.update({ dx: 1, dy: 0, drawHeld: false, confirm: false });
    recorder.observe(session, { dx: 1, dy: 0, drawHeld: false });
    expect(recorder.getSamples().length).toBe(1);

    recorder.reset();
    expect(recorder.getSamples()).toEqual([]);

    // After reset(), a TickSource that "restarts" its own tick counter from
    // 0 (mirroring GameSession.resetToFreshRun()) is recorded from scratch,
    // not skipped as "already seen" ticks.
    const fresh: TickSource = { getTotalTicks: () => 1 };
    recorder.observe(fresh, { dx: -1, dy: 0, drawHeld: true });
    expect(recorder.getSamples()).toEqual([{ dx: -1, dy: 0, drawHeld: true, slow: false }]);
  });

  it('never records past MAX_INPUT_SAMPLES, via a fake TickSource (no real 10800-tick run needed)', () => {
    const recorder = new InputRecorder();
    let tick = 0;
    const fake: TickSource = { getTotalTicks: () => tick };
    for (let i = 0; i < 10805; i++) {
      tick++;
      recorder.observe(fake, { dx: 0, dy: 0, drawHeld: false });
    }
    expect(recorder.getSamples().length).toBe(10800);
  });

  it('encode() round-trips via the RLE codec', async () => {
    const { decodeRleToSamples } = await import('./rle');
    const session = new GameSession({ seed: 4 });
    const recorder = new InputRecorder();
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    for (let i = 0; i < 5; i++) {
      session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
      recorder.observe(session, { dx: 0, dy: 1, drawHeld: true });
    }
    expect(decodeRleToSamples(recorder.encode())).toEqual(recorder.getSamples());
  });
});
