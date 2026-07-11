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
