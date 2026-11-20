// Lightweight AudioContext mocks (no jsdom/happy-dom dependency — this repo's
// vitest environment is plain 'node'). Only covers the surface `resume()` /
// `unlockAudioOutput()` actually touch: this test exists specifically to
// pin down the iOS WebKit unlock fix (fix/ios-audio-unlock, GitHub #4) — that
// a silent buffer is played exactly once per AudioContext, regardless of how
// many times resume() is invoked (e.g. once per keydown/pointerdown, per
// main.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SFX_LOG_NAMES, SfxEngine, claimChainPitch, type SfxLogName } from './sfx';
import { resetSfxLevels, sfxLevels, sfxPeak } from './sfxLevels';

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
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(expect.closeTo(0.18, 12), 0.01);
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
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(expect.closeTo(0.18, 12), 0.01);
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

    // The 90 Hz fall, then its octave-up layer for small speakers.
    expect(oscillators).toHaveLength(2);
    const [osc, layer] = oscillators;
    expect(osc.type).toBe('sawtooth');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(90, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(36, 0.33);
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.28 * 0.8, 0.004);
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.33);
    expect(osc.stop.mock.calls[0][0]).toBeLessThanOrEqual(0.35 + 1e-9);
    // The layer falls the same way at the same moment, quieter, and ends as soon.
    expect(layer.type).toBe('sawtooth');
    expect(layer.frequency.setValueAtTime).toHaveBeenCalledWith(180, 0);
    expect(layer.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(72, 0.33);
    const [layerPeak, layerPeakAt] = gains[2].gain.linearRampToValueAtTime.mock.calls[0];
    expect(layerPeak).toBeCloseTo(0.28 * 0.4, 12);
    expect(layerPeak).toBeLessThan(0.28 * 0.8);
    expect(layerPeakAt).toBe(0.004);
    expect(layer.stop.mock.calls[0][0]).toBeLessThanOrEqual(0.35 + 1e-9);
  });

  it('still plays the ember despawn as a triangle falling from 620 Hz to 250 Hz over 0.1s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().handleEvents(['ember-despawned']);

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('triangle');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(620, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(250, 0.1);
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.1);
    expect(osc.stop).toHaveBeenCalledWith(expect.closeTo(0.12, 9));
    const [peak, at] = gains[1].gain.linearRampToValueAtTime.mock.calls[0];
    expect(peak).toBeCloseTo(0.13 * 0.85, 12);
    expect(at).toBe(0.01);
  });

  it('plays the ember spawn as a steady 520 Hz square wave for 0.1s', () => {
    const { oscillators, gains } = installRecordingAudioContext();

    new SfxEngine().handleEvents(['ember-spawned']);

    expect(oscillators).toHaveLength(1);
    const [osc] = oscillators;
    expect(osc.type).toBe('square');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(520, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(gains[1].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.1);
    expect(osc.stop).toHaveBeenCalledWith(expect.closeTo(0.12, 9));
    const [peak, at] = gains[1].gain.linearRampToValueAtTime.mock.calls[0];
    expect(peak).toBeCloseTo(0.13 * 0.85, 12);
    expect(at).toBe(0.01);
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

  it('plays both clear arpeggios with short notes that peak at once', () => {
    for (const play of [(s: SfxEngine) => s.playSplitImpact(), (s: SfxEngine) => s.handleEvents(['stage-clear'])]) {
      const { oscillators, gains } = installRecordingAudioContext();
      play(new SfxEngine());
      const arpeggio = oscillators.length === 6 ? oscillators.slice(1) : oscillators;
      const envs = oscillators.length === 6 ? gains.slice(2) : gains.slice(1);
      expect(arpeggio.length).toBeGreaterThanOrEqual(4);
      envs.forEach((env, i) => {
        const start = startTime(arpeggio[i]);
        expect(peakTime(env) - start).toBeCloseTo(0.004, 9);
        expect(endTime(env) - start).toBeLessThanOrEqual(0.11 + 1e-9);
      });
    }
  });
});

// The peak a sound's first note reaches (its envelope's linear ramp).
const firstPeak = (gains: MockGainNode[]): number => gains[1].gain.linearRampToValueAtTime.mock.calls[0][0];

function peakOf(play: (sfx: SfxEngine) => void): number {
  const { gains } = installRecordingAudioContext();
  play(new SfxEngine());
  return firstPeak(gains);
}

// The miss's two voices (the fall and its octave-up layer), which start
// together: each one's peak, and the two added up.
function missPeaks(): { fall: number; layer: number; sum: number } {
  const { gains } = installRecordingAudioContext();
  new SfxEngine().handleEvents(['miss']);
  const fall = gains[1].gain.linearRampToValueAtTime.mock.calls[0];
  const layer = gains[2].gain.linearRampToValueAtTime.mock.calls[0];
  expect(gains).toHaveLength(3);
  expect(layer[1]).toBe(fall[1]);
  return { fall: fall[0], layer: layer[0], sum: fall[0] + layer[0] };
}

describe('SfxEngine — loudness from the level table', () => {
  afterEach(() => resetSfxLevels());

  it('the two voices of the miss peak together at 0.224 + 0.112 = 0.336, under the split impact (0.36)', () => {
    const split = peakOf((s) => s.playSplitImpact());
    const { fall, layer, sum } = missPeaks();
    expect(fall).toBeCloseTo(0.224, 12);
    expect(layer).toBeCloseTo(0.112, 12);
    expect(sum).toBeCloseTo(0.336, 12);
    expect(split).toBeCloseTo(0.36, 12);
    expect(split).toBeGreaterThan(sum);
  });

  it('ranks the peaks: split > miss (its two voices together) >= claim hit > time alarm > Igniter spawn > draw drone', () => {
    const split = peakOf((s) => s.playSplitImpact());
    const miss = missPeaks().sum;
    const claim = peakOf((s) => s.playClaim({ share: 0.02, speed: 'fast' }));
    const alarm = peakOf((s) => s.playTimeWarning('alarm'));
    const igniter = peakOf((s) => s.handleEvents(['igniter-spawned']));
    const draw = peakOf((s) => s.setDrawing(true, 'fast'));
    expect(split).toBeGreaterThan(miss);
    expect(miss).toBeGreaterThanOrEqual(claim);
    expect(claim).toBeGreaterThan(alarm);
    expect(alarm).toBeGreaterThan(igniter);
    expect(igniter).toBeGreaterThan(draw);
    expect(split).toBeCloseTo(sfxPeak('split-impact'), 12);
    expect(draw).toBeCloseTo(sfxPeak('draw'), 12);
  });

  it('plays the next sound at a changed tier level', () => {
    const { gains } = installRecordingAudioContext();
    const sfx = new SfxEngine();
    sfx.handleEvents(['miss']);
    sfxLevels.impact = 0.12;
    sfx.handleEvents(['miss']);
    // Each miss makes two envelopes (the fall and its octave-up layer); the
    // first of each is the miss itself.
    expect(gains[1].gain.linearRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(0.28 * 0.8, 12);
    expect(gains[3].gain.linearRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(0.12 * 0.8, 12);
  });

  it('applies a changed master to the master gain at once, and keeps it at 0 while muted', () => {
    const { gains } = installRecordingAudioContext();
    const sfx = new SfxEngine();
    sfx.resume();
    const master = gains[0];
    expect(master.gain.value).toBe(sfxLevels.master);
    sfxLevels.master = 0.4;
    sfx.applyMasterLevel();
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 0, 0.01);
    sfx.setMuted(true);
    sfxLevels.master = 0.3;
    sfx.applyMasterLevel();
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.01);
  });
});

describe('SfxEngine — the GAME OVER sounds', () => {
  const startFreq = (osc: MockOscillatorNode): number => osc.frequency.setValueAtTime.mock.calls[0][0];

  it('closes a lost last life and TIME UP! with a low hit, then three different notes ending higher than they start', () => {
    const notes = (reason: 'life' | 'time') => {
      const { oscillators } = installRecordingAudioContext();
      new SfxEngine().playGameOver(reason);
      expect(oscillators).toHaveLength(4);
      const [hit, ...rest] = oscillators;
      expect(hit.type).toBe('square');
      expect(startFreq(hit)).toBe(110);
      expect(hit.frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeLessThan(110);
      for (const osc of rest) expect(osc.type).toBe('triangle');
      return rest.map(startFreq);
    };
    const life = notes('life');
    const time = notes('time');
    expect(life).toEqual([392, 494, 587]);
    expect(time).toEqual([330, 415, 494]);
    expect(life).not.toEqual(time);
    for (const n of [life, time]) expect(n[n.length - 1]).toBeGreaterThan(n[0]);
  });

  it('plays the count tick, the count end and the new-record fanfare at their pitches', () => {
    const play = (fn: (s: SfxEngine) => void) => {
      const { oscillators } = installRecordingAudioContext();
      fn(new SfxEngine());
      return oscillators.map((o) => [o.type, startFreq(o)]);
    };
    expect(play((s) => s.playCountTick())).toEqual([['triangle', 1175]]);
    expect(play((s) => s.playCountEnd())).toEqual([
      ['triangle', 784],
      ['triangle', 1175],
    ]);
    expect(play((s) => s.playNewRecord())).toEqual([659, 784, 988, 1319, 1568].map((f) => ['square', f]));
  });

  it('keeps clear of the time warning beeps and the claim hit', () => {
    const { oscillators } = installRecordingAudioContext();
    const sfx = new SfxEngine();
    sfx.playGameOver('life');
    sfx.playGameOver('time');
    sfx.playCountTick();
    sfx.playCountEnd();
    sfx.playNewRecord();
    for (const osc of oscillators) expect([880, 1320, 1047]).not.toContain(startFreq(osc));
  });

  it('records the name of every sound played, and nothing while muted', () => {
    installRecordingAudioContext();
    const sfx = new SfxEngine();
    sfx.playGameOver('life');
    sfx.playGameOver('time');
    sfx.playCountTick();
    sfx.playCountEnd();
    sfx.playNewRecord();
    sfx.handleEvents(['miss', 'stage-clear', 'area-claimed']);
    sfx.playClaim({ share: 0.3, speed: 'fast' });
    sfx.playTimeWarning('beep-high');
    expect(sfx.getLog()).toEqual([
      'gameover-life',
      'gameover-time',
      'count-tick',
      'count-end',
      'new-record',
      'miss',
      'stage-clear',
      'claim-large',
      'beep-high',
    ]);
    sfx.setMuted(true);
    sfx.playNewRecord();
    expect(sfx.getLog()).toHaveLength(9);
    sfx.setMuted(false);
    for (let i = 0; i < 100; i++) sfx.playCountTick();
    expect(sfx.getLog()).toHaveLength(64);
  });
});

// How to play each recorded sound by itself. Typed against every name, so a
// sound added to SFX_LOG_NAMES fails the typecheck until it is listed here.
const PLAY_BY_NAME: Record<SfxLogName, (s: SfxEngine) => void> = {
  'claim-small': (s) => s.playClaim({ share: 0.02, speed: 'fast' }),
  'claim-mid': (s) => s.playClaim({ share: 0.1, speed: 'fast' }),
  'claim-large': (s) => s.playClaim({ share: 0.3, speed: 'fast' }),
  split: (s) => s.playSplitImpact(),
  miss: (s) => s.handleEvents(['miss']),
  'stage-clear': (s) => s.handleEvents(['stage-clear']),
  'gameover-life': (s) => s.playGameOver('life'),
  'gameover-time': (s) => s.playGameOver('time'),
  count: (s) => s.playCountSample(),
  'count-tick': (s) => s.playCountTick(),
  'count-end': (s) => s.playCountEnd(),
  'new-record': (s) => s.playNewRecord(),
  alarm: (s) => s.playTimeWarning('alarm'),
  beep: (s) => s.playTimeWarning('beep'),
  'beep-high': (s) => s.playTimeWarning('beep-high'),
  'igniter-spawn': (s) => s.handleEvents(['igniter-spawned']),
  'igniter-approach': (s) => s.handleEvents(['igniter-approaching']),
  'ember-spawn': (s) => s.handleEvents(['ember-spawned']),
  'blaze-spawn': (s) => s.handleEvents(['ember-blaze-spawned']),
  'ember-line': (s) => s.handleEvents(['ember-entered-line']),
  'ember-out': (s) => s.handleEvents(['ember-despawned']),
  draw: (s) => s.playDrawSample(),
};

interface Voice {
  type: string;
  /** The pitch the oscillator starts at. */
  from: number;
  /** The pitch it glides to (its start pitch when it holds). */
  to: number;
}

// Every oscillator a sound creates, with its waveform and pitch.
function voicesOf(name: SfxLogName): { voices: Voice[]; log: string[] } {
  const { oscillators } = installRecordingAudioContext();
  const sfx = new SfxEngine();
  PLAY_BY_NAME[name](sfx);
  const voices = oscillators.map((osc) => {
    const from = (osc.frequency.setValueAtTime.mock.calls[0]?.[0] as number | undefined) ?? osc.frequency.value;
    const to = (osc.frequency.exponentialRampToValueAtTime.mock.calls[0]?.[0] as number | undefined) ?? from;
    return { type: osc.type, from, to };
  });
  return { voices, log: sfx.getLog() };
}

// Heard on a small speaker: a pitch (start or end) at 400 Hz or more, or a
// square / sawtooth (whose overtones reach 400 Hz) at 150 Hz or more.
function isAudibleOnSmallSpeakers({ type, from, to }: Voice): boolean {
  const top = Math.max(from, to);
  if (top >= 400) return true;
  return (type === 'square' || type === 'sawtooth') && top >= 150;
}

describe('SfxEngine — the voices of every recorded sound', () => {
  it('gives every sound but the draw drone at least one voice at 400 Hz or more, or a square / sawtooth at 150 Hz or more', () => {
    const unheard = SFX_LOG_NAMES.filter((name) => name !== 'draw')
      .map((name) => ({ name, voices: voicesOf(name).voices }))
      .filter(({ voices }) => !voices.some(isAudibleOnSmallSpeakers));
    expect(unheard).toEqual([]);
  });

  it('judges a voice by the small-speaker rule', () => {
    expect(isAudibleOnSmallSpeakers({ type: 'triangle', from: 400, to: 400 })).toBe(true);
    expect(isAudibleOnSmallSpeakers({ type: 'sine', from: 180, to: 450 })).toBe(true);
    expect(isAudibleOnSmallSpeakers({ type: 'triangle', from: 399, to: 160 })).toBe(false);
    expect(isAudibleOnSmallSpeakers({ type: 'sawtooth', from: 150, to: 60 })).toBe(true);
    expect(isAudibleOnSmallSpeakers({ type: 'square', from: 149, to: 60 })).toBe(false);
    expect(isAudibleOnSmallSpeakers({ type: 'sine', from: 260, to: 260 })).toBe(false);
  });

  it('plays every recorded name by itself, under that name only', () => {
    expect(Object.keys(PLAY_BY_NAME).sort()).toEqual([...SFX_LOG_NAMES].sort());
    for (const name of SFX_LOG_NAMES) {
      const { voices, log } = voicesOf(name);
      expect(log, name).toEqual([name]);
      expect(voices.length, name).toBeGreaterThan(0);
    }
  });

  it('keeps the draw drone a waveform with overtones (it stays in the quietest tier, outside the small-speaker rule)', () => {
    for (const voice of voicesOf('draw').voices) expect(['square', 'sawtooth']).toContain(voice.type);
  });

  it('holds the Ember spawn, drops the Ember despawn, and keeps both below the time warning beeps and the claim hit', () => {
    const [spawn] = voicesOf('ember-spawn').voices;
    const [out] = voicesOf('ember-out').voices;
    expect(spawn.to).toBe(spawn.from);
    expect(out.to).toBeLessThan(out.from);
    for (const v of [spawn, out]) expect(Math.max(v.from, v.to)).toBeLessThan(Math.min(880, 1320, 1047));
  });

  it('tells the three spawn sounds apart by waveform or pitch', () => {
    const spawns = (['ember-spawn', 'blaze-spawn', 'igniter-spawn'] as const).map((name) => voicesOf(name).voices[0]);
    for (let i = 0; i < spawns.length; i++) {
      for (let j = i + 1; j < spawns.length; j++) {
        const a = spawns[i];
        const b = spawns[j];
        expect(a.type !== b.type || a.from !== b.from, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true);
      }
    }
  });
});

describe('SfxEngine — muted', () => {
  it('creates no oscillator for any sound, old or new', () => {
    const { oscillators } = installRecordingAudioContext();
    const sfx = new SfxEngine(true);
    sfx.handleEvents([
      'stage-clear',
      'miss',
      'igniter-spawned',
      'igniter-approaching',
      'ember-spawned',
      'ember-blaze-spawned',
      'ember-entered-line',
      'ember-despawned',
    ]);
    sfx.playClaim({ share: 0.3, speed: 'slow' });
    sfx.playSplitImpact();
    sfx.playTimeWarning('alarm');
    sfx.setDrawing(true, 'fast');
    sfx.playGameOver('life');
    sfx.playGameOver('time');
    sfx.playCountTick();
    sfx.playCountEnd();
    sfx.playNewRecord();
    expect(oscillators).toHaveLength(0);
    expect(sfx.getLog()).toEqual([]);
  });
});
