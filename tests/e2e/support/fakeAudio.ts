// A stand-in for the page's AudioContext, installed before the page loads:
// nothing sounds, every oscillator's start time is recorded (and how many
// buffer sources, the music's noise, were made), and the audio
// clock (`currentTime`) is the page's performance.now() — which
// page.clock.install() fakes — so running the faked clock runs the audio
// clock by exactly as much. The product code is unchanged: it still builds
// its context from window.AudioContext.
import type { Page } from '@playwright/test';

export interface FakeAudioRecord {
  /** Every oscillator's start time, in the order they were started. */
  starts: number[];
  /** How many buffer sources (the music's drums) were made. */
  sources: number;
}

declare global {
  interface Window {
    __fakeAudio__?: FakeAudioRecord;
  }
}

export async function installFakeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record: { starts: number[]; sources: number } = { starts: [], sources: 0 };
    (window as unknown as { __fakeAudio__: typeof record }).__fakeAudio__ = record;
    const origin = performance.now();
    class Param {
      value = 0;
      setValueAtTime(v: number): this {
        this.value = v;
        return this;
      }
      linearRampToValueAtTime(v: number): this {
        this.value = v;
        return this;
      }
      exponentialRampToValueAtTime(v: number): this {
        this.value = v;
        return this;
      }
      setTargetAtTime(v: number): this {
        this.value = v;
        return this;
      }
      cancelScheduledValues(): this {
        return this;
      }
    }
    class Node {
      connect<T>(node: T): T {
        return node;
      }
      disconnect(): void {}
      addEventListener(): void {}
    }
    class Gain extends Node {
      gain = new Param();
    }
    class Filter extends Node {
      type = 'lowpass';
      frequency = new Param();
      Q = new Param();
    }
    class Osc extends Node {
      type = 'sine';
      frequency = new Param();
      detune = new Param();
      start(t?: number): void {
        record.starts.push(t ?? 0);
      }
      stop(): void {}
    }
    class Source extends Node {
      buffer: unknown = null;
      start(): void {}
      stop(): void {}
    }
    class FakeAudioContext {
      state = 'running';
      destination = new Node();
      sampleRate = 44100;
      get currentTime(): number {
        return (performance.now() - origin) / 1000;
      }
      createGain(): Gain {
        return new Gain();
      }
      createOscillator(): Osc {
        return new Osc();
      }
      createBiquadFilter(): Filter {
        return new Filter();
      }
      // The music's noise is written into its one channel.
      createBuffer(_channels: number, length: number): object {
        const data = new Float32Array(length);
        return { length, getChannelData: () => data };
      }
      createBufferSource(): Source {
        record.sources++;
        return new Source();
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
}

/** Hides or shows the page as far as the game can tell, with its visibilitychange. */
export async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
