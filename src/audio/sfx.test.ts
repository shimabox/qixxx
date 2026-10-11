// Lightweight AudioContext mocks (no jsdom/happy-dom dependency — this repo's
// vitest environment is plain 'node'). Only covers the surface `resume()` /
// `unlockAudioOutput()` actually touch: this test exists specifically to
// pin down the iOS WebKit unlock fix (fix/ios-audio-unlock, GitHub #4) — that
// a silent buffer is played exactly once per AudioContext, regardless of how
// many times resume() is invoked (e.g. once per keydown/pointerdown, per
// main.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SfxEngine } from './sfx';

class MockGainNode {
  gain = {
    value: 0,
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect(): this {
    return this;
  }
  disconnect(): void {}
}

class MockBufferSourceNode {
  buffer: unknown = null;
  connect(): void {}
  start(): void {}
}

class MockOscillatorNode {
  type = 'sine';
  frequency = {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
  connect(): this {
    return this;
  }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
  addEventListener(): void {}
}

class MockAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = {};
  currentTime = 0;
  createGain(): MockGainNode {
    return new MockGainNode();
  }
  createBuffer(channels: number, length: number, sampleRate: number): { channels: number; length: number; sampleRate: number } {
    return { channels, length, sampleRate };
  }
  createBufferSource(): MockBufferSourceNode {
    return new MockBufferSourceNode();
  }
  // Only needed by tests that exercise playTone()/setDrawing() (e.g. via
  // handleEvents()), not by the original unlock tests above — those never
  // reach a code path that creates an oscillator.
  createOscillator(): MockOscillatorNode {
    return new MockOscillatorNode();
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

afterEach(() => {
  // Avoid leaking the mock `window` into other test files.
  delete (globalThis as { window?: unknown }).window;
});

describe('SfxEngine — iOS WebKit audio unlock (fix/ios-audio-unlock, GitHub #4)', () => {
  it('plays exactly one silent buffer across many resume() calls', () => {
    const createBufferSourceSpy = vi.fn(() => new MockBufferSourceNode());
    class SpyAudioContext extends MockAudioContext {
      createBufferSource(): MockBufferSourceNode {
        return createBufferSourceSpy();
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SpyAudioContext };

    const sfx = new SfxEngine();
    sfx.resume();
    sfx.resume();
    sfx.resume();

    expect(createBufferSourceSpy).toHaveBeenCalledTimes(1);
  });

  it('retries the unlock on the next resume() while the context stays suspended', () => {
    // iOS ignores the unlock from a non-activating event (touch pointerdown);
    // the following touchend/pointerup must get another attempt.
    const createBufferSourceSpy = vi.fn(() => new MockBufferSourceNode());
    class StuckAudioContext extends MockAudioContext {
      createBufferSource(): MockBufferSourceNode {
        return createBufferSourceSpy();
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: StuckAudioContext };

    const sfx = new SfxEngine();
    sfx.resume();
    sfx.resume();

    expect(createBufferSourceSpy).toHaveBeenCalledTimes(2);
  });

  it('calls ctx.resume() when iOS reports the context as interrupted', () => {
    const resumeSpy = vi.fn(() => Promise.resolve());
    class InterruptedAudioContext extends MockAudioContext {
      state = 'interrupted' as unknown as 'suspended';
      resume(): Promise<void> {
        return resumeSpy();
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: InterruptedAudioContext };

    const sfx = new SfxEngine();
    sfx.resume();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('still calls ctx.resume() when the context starts suspended', () => {
    const resumeSpy = vi.fn(function (this: MockAudioContext) {
      this.state = 'running';
      return Promise.resolve();
    });
    class SpyAudioContext extends MockAudioContext {
      resume(): Promise<void> {
        return resumeSpy.call(this);
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SpyAudioContext };

    const sfx = new SfxEngine();
    sfx.resume();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('unlocks again after dispose() + a fresh AudioContext is created', () => {
    const createBufferSourceSpy = vi.fn(() => new MockBufferSourceNode());
    class SpyAudioContext extends MockAudioContext {
      createBufferSource(): MockBufferSourceNode {
        return createBufferSourceSpy();
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SpyAudioContext };

    const sfx = new SfxEngine();
    sfx.resume();
    sfx.dispose();
    sfx.resume();

    expect(createBufferSourceSpy).toHaveBeenCalledTimes(2);
  });
});

describe('SfxEngine — retry resume() on sound-producing calls (fix/ios-audio-retry-suspended, GitHub #4)', () => {
  // Regression coverage for: resume()'s ctx.resume() is fire-and-forget
  // (never awaited), so on iOS the AudioContext can still report
  // 'suspended' for a while after resume() returns. If the first SE fires
  // in that window it's silently dropped. playTone()/setDrawing() must each
  // retry ctx.resume() themselves rather than assuming resume() already
  // finished the job.
  it('retries ctx.resume() from playTone() (via handleEvents) when the context is still suspended', () => {
    const resumeSpy = vi.fn(function (this: MockAudioContext) {
      this.state = 'running';
      return Promise.resolve();
    });
    class SpyAudioContext extends MockAudioContext {
      resume(): Promise<void> {
        return resumeSpy.call(this);
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SpyAudioContext };

    const sfx = new SfxEngine();
    // Deliberately skip resume() — simulates a sound firing before the
    // user-gesture resume() Promise has settled.
    sfx.handleEvents(['area-claimed']);

    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call ctx.resume() from playTone() when the context is already running', () => {
    const resumeSpy = vi.fn(function (this: MockAudioContext) {
      this.state = 'running';
      return Promise.resolve();
    });
    class SpyAudioContext extends MockAudioContext {
      state: 'suspended' | 'running' | 'closed' = 'running';
      resume(): Promise<void> {
        return resumeSpy.call(this);
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SpyAudioContext };

    const sfx = new SfxEngine();
    sfx.handleEvents(['area-claimed']);

    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('retries ctx.resume() from setDrawing() when the context is still suspended', () => {
    const resumeSpy = vi.fn(function (this: MockAudioContext) {
      this.state = 'running';
      return Promise.resolve();
    });
    class SpyAudioContext extends MockAudioContext {
      resume(): Promise<void> {
        return resumeSpy.call(this);
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SpyAudioContext };

    const sfx = new SfxEngine();
    sfx.setDrawing(true, 'fast');

    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });
});

// Records every node a one-shot creates, so a test can read back what
// playTone() asked Web Audio for: pitch, waveform, pitch glide and peak gain.
function installRecordingAudioContext(): { oscillators: MockOscillatorNode[]; gains: MockGainNode[] } {
  const oscillators: MockOscillatorNode[] = [];
  const gains: MockGainNode[] = [];
  class RecordingAudioContext extends MockAudioContext {
    state: 'suspended' | 'running' | 'closed' = 'running';
    createOscillator(): MockOscillatorNode {
      const osc = new MockOscillatorNode();
      oscillators.push(osc);
      return osc;
    }
    createGain(): MockGainNode {
      const gain = new MockGainNode();
      gains.push(gain);
      return gain;
    }
  }
  (globalThis as { window?: unknown }).window = { AudioContext: RecordingAudioContext };
  return { oscillators, gains };
}

describe('SfxEngine — TIME countdown warning cues', () => {
  it('plays the alarm as a square wave rising from 440 Hz to 880 Hz over 0.4s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().playTimeWarning('alarm');

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('square');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(880, 0.4);
    // gains[0] is the master gain; gains[1] this note's own envelope.
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.2, 0.01);
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.4);
  });

  it('plays the beep as a steady 880 Hz square wave for 0.07s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().playTimeWarning('beep');

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('square');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.16, 0.01);
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.07);
  });

  it('plays the high beep as a steady 1320 Hz square wave for 0.07s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().playTimeWarning('beep-high');

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('square');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(1320, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.16, 0.01);
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.07);
  });

  it('creates no oscillator for any cue while muted', () => {
    const { oscillators } = installRecordingAudioContext();

    const sfx = new SfxEngine(true);
    sfx.playTimeWarning('alarm');
    sfx.playTimeWarning('beep');
    sfx.playTimeWarning('beep-high');

    expect(oscillators).toHaveLength(0);
  });

  it('plays again once unmuted', () => {
    const { oscillators } = installRecordingAudioContext();

    const sfx = new SfxEngine(true);
    sfx.playTimeWarning('beep');
    sfx.setMuted(false);
    sfx.playTimeWarning('beep-high');

    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(1320, 0);
  });
});

describe('SfxEngine — pitch glide of the existing one-shots', () => {
  it('still plays the miss falling from 90 Hz to 36 Hz over 0.35s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().handleEvents(['miss']);

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('sawtooth');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(90, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(36, 0.35);
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 0.01);
  });

  it('still plays the ember despawn falling from 180 Hz to 72 Hz over 0.07s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().handleEvents(['ember-despawned']);

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('sine');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(180, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(72, 0.07);
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.15, 0.01);
  });

  it('still holds the pitch of every other one-shot and arpeggio note', () => {
    const { oscillators } = installRecordingAudioContext();

    new SfxEngine().handleEvents([
      'area-claimed',
      'stage-clear',
      'split-clear',
      'igniter-spawned',
      'igniter-approaching',
      'ember-spawned',
      'ember-blaze-spawned',
      'ember-entered-line',
    ]);

    // 5 single notes + the 4-, 5- and 2-note arpeggios.
    expect(oscillators).toHaveLength(16);
    for (const osc of oscillators) {
      expect(osc.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    }
  });
});
