// Lightweight AudioContext mocks (no jsdom/happy-dom dependency — this repo's
// vitest environment is plain 'node'). Only covers the surface `resume()` /
// `unlockAudioOutput()` actually touch: this test exists specifically to
// pin down the iOS WebKit unlock fix (fix/ios-audio-unlock, GitHub #4) — that
// a silent buffer is played exactly once per AudioContext, regardless of how
// many times resume() is invoked (e.g. once per keydown/pointerdown, per
// main.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SfxEngine, claimChainPitch } from './sfx';

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
  stop = vi.fn();
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
    sfx.handleEvents(['miss']);

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
    sfx.handleEvents(['miss']);

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
  it('plays the miss falling from 90 Hz to 36 Hz, peaking within 5ms and ending within 0.35s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().handleEvents(['miss']);

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('sawtooth');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(90, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(36, 0.33);
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 0.004);
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.33);
    expect(osc.stop.mock.calls[0][0]).toBeLessThanOrEqual(0.35 + 1e-9);
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

    // 4 single notes + the 4- and 2-note arpeggios. area-claimed and
    // split-clear are silent here: main.ts plays them from the claim notice
    // (playClaim() / playSplitImpact()).
    expect(oscillators).toHaveLength(10);
    for (const osc of oscillators) {
      expect(osc.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    }
  });

  it('plays nothing for area-claimed or split-clear events', () => {
    const { oscillators } = installRecordingAudioContext();
    new SfxEngine().handleEvents(['area-claimed', 'split-clear']);
    expect(oscillators).toHaveLength(0);
  });
});

describe('SfxEngine — claim and split sounds', () => {
  const peakTime = (gain: MockGainNode): number => gain.gain.linearRampToValueAtTime.mock.calls[0][1];
  const endTime = (gain: MockGainNode): number => gain.gain.exponentialRampToValueAtTime.mock.calls[0][1];
  const startFreq = (osc: MockOscillatorNode): number => osc.frequency.setValueAtTime.mock.calls[0][0];
  const startTime = (osc: MockOscillatorNode): number => osc.frequency.setValueAtTime.mock.calls[0][1];

  it('a small claim: a short hit peaking within 5ms and over within 0.08s, then a 0.2s rising sweep', () => {
    const { oscillators, gains } = installRecordingAudioContext();
    new SfxEngine().playClaim({ share: 0.02, speed: 'fast' });

    expect(oscillators).toHaveLength(2);
    const [hit, rise] = oscillators;
    const [, hitEnv, riseEnv] = gains;
    expect(peakTime(hitEnv)).toBeLessThanOrEqual(0.005);
    expect(endTime(hitEnv)).toBeLessThanOrEqual(0.08);
    expect(hit.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    // The sweep starts when the hit ends, rises, and lasts 0.2s.
    expect(startTime(rise)).toBeCloseTo(endTime(hitEnv));
    const [riseTo, riseEnd] = rise.frequency.exponentialRampToValueAtTime.mock.calls[0];
    expect(riseTo).toBeGreaterThan(startFreq(rise));
    expect(riseEnd - startTime(rise)).toBeCloseTo(0.2);
    expect(endTime(riseEnv) - startTime(rise)).toBeCloseTo(0.2);
  });

  it('adds a low layer near 220 Hz for a mid claim and near 110 Hz for a large one, both short and sharp', () => {
    for (const [share, low] of [
      [0.1, 220],
      [0.3, 110],
    ] as const) {
      const { oscillators, gains } = installRecordingAudioContext();
      new SfxEngine().playClaim({ share, speed: 'fast' });
      expect(oscillators).toHaveLength(3);
      expect(startFreq(oscillators[1])).toBe(low);
      expect(peakTime(gains[2])).toBeLessThanOrEqual(0.005);
      expect(endTime(gains[2])).toBeLessThanOrEqual(0.08);
    }
  });

  it('rises further for a slow line', () => {
    const fast = installRecordingAudioContext();
    new SfxEngine().playClaim({ share: 0.02, speed: 'fast' });
    const fastTo = fast.oscillators[1].frequency.exponentialRampToValueAtTime.mock.calls[0][0];
    const slow = installRecordingAudioContext();
    new SfxEngine().playClaim({ share: 0.02, speed: 'slow' });
    const slowTo = slow.oscillators[1].frequency.exponentialRampToValueAtTime.mock.calls[0][0];
    expect(slowTo).toBeGreaterThan(fastTo);
  });

  it('the split: a low thump over within 0.12s, then the 5-note split arpeggio after it', () => {
    const { oscillators, gains } = installRecordingAudioContext();
    new SfxEngine().playSplitImpact();

    expect(oscillators).toHaveLength(6);
    const [thump, ...arpeggio] = oscillators;
    expect(startFreq(thump)).toBeLessThan(120);
    expect(peakTime(gains[1])).toBeLessThanOrEqual(0.005);
    expect(endTime(gains[1])).toBeLessThanOrEqual(0.12);
    expect(arpeggio.map(startFreq)).toEqual([784, 988, 1175, 1568, 1976]);
    expect(startTime(arpeggio[0])).toBeCloseTo(endTime(gains[1]));
  });

  it('raises the hit and the sweep two semitones per chain step, up to 6 steps; the low layer keeps its pitch', () => {
    const play = (chain?: number) => {
      const rec = installRecordingAudioContext();
      new SfxEngine().playClaim(chain === undefined ? { share: 0.1, speed: 'fast' } : { share: 0.1, speed: 'fast', chain });
      const [hit, low, rise] = rec.oscillators;
      return {
        hit: startFreq(hit),
        low: startFreq(low),
        riseFrom: startFreq(rise),
        riseTo: rise.frequency.exponentialRampToValueAtTime.mock.calls[0][0] as number,
      };
    };
    const first = play(1);
    expect(play()).toEqual(first); // no chain given = the first claim
    expect(first.hit).toBe(1047);
    for (let chain = 2; chain <= 7; chain++) {
      const ratio = Math.pow(2, (2 * (chain - 1)) / 12);
      const sound = play(chain);
      expect(sound.hit).toBeCloseTo(first.hit * ratio, 6);
      expect(sound.riseFrom).toBeCloseTo(first.riseFrom * ratio, 6);
      expect(sound.riseTo).toBeCloseTo(first.riseTo * ratio, 6);
      expect(sound.low).toBe(first.low);
      expect(sound.hit).toBeGreaterThan(play(chain - 1).hit);
    }
    // Six steps (chain 7) is the top.
    expect(play(8)).toEqual(play(7));
    expect(play(30)).toEqual(play(7));
  });

  it('claimChainPitch: 1 for the first claim, +2 semitones a step, capped', () => {
    expect(claimChainPitch(1, 6)).toBe(1);
    expect(claimChainPitch(0, 6)).toBe(1);
    expect(claimChainPitch(2, 6)).toBeCloseTo(Math.pow(2, 2 / 12), 12);
    expect(claimChainPitch(7, 6)).toBeCloseTo(Math.pow(2, 12 / 12), 12);
    expect(claimChainPitch(20, 6)).toBe(claimChainPitch(7, 6));
    expect(claimChainPitch(5, 2)).toBe(claimChainPitch(3, 2));
  });

  it('the split sound does not change with the chain', () => {
    const freqs = () => {
      const rec = installRecordingAudioContext();
      new SfxEngine().playSplitImpact();
      return rec.oscillators.map(startFreq);
    };
    const before = freqs();
    new SfxEngine().playClaim({ share: 0.1, speed: 'fast', chain: 5 });
    expect(freqs()).toEqual(before);
  });

  it('plays neither while muted', () => {
    const { oscillators } = installRecordingAudioContext();
    const sfx = new SfxEngine(true);
    sfx.playClaim({ share: 0.3, speed: 'slow' });
    sfx.playSplitImpact();
    expect(oscillators).toHaveLength(0);
  });
});
