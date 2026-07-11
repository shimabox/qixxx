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
