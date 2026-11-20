// The BGM player on a faked audio clock: a recording AudioContext stand-in
// whose currentTime the test moves by hand.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BGM_HAT, BGM_KICK, BGM_KICK_CLICK, BGM_SNARE, BgmPlayer, fillBgmNoise, type BgmGraph, type BgmUpdate } from './bgm';
import { BGM_GAIN_ACID, BGM_GAIN_HUNT, BGM_GAIN_TENSE, BGM_LOOKAHEAD_SEC } from '../config';
import { bgmNotesForStep, bgmStepSeconds, type BgmTrackId } from './bgmScore';

// TENSE's tempos (the first stage's tune).
const TENSE_BPM = 126;
const TENSE_RUSH_BPM = 140;

interface ParamCall {
  method: string;
  value: number;
  time: number;
}

class FakeParam {
  value = 0;
  calls: ParamCall[] = [];
  setValueAtTime(value: number, time: number): void {
    this.calls.push({ method: 'set', value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ method: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ method: 'exp', value, time });
  }
  setTargetAtTime(value: number, time: number): void {
    this.calls.push({ method: 'target', value, time });
  }
  cancelScheduledValues(time: number): void {
    this.calls.push({ method: 'cancel', value: 0, time });
  }
}

class FakeNode {
  outputs: FakeNode[] = [];
  disconnected = false;
  connect<T extends FakeNode>(node: T): T {
    this.outputs.push(node);
    return node;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam();
  Q = new FakeParam();
}

class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  detune = new FakeParam();
  startAt: number | null = null;
  stopAt: number | null = null;
  private ended: Array<() => void> = [];
  start(t: number): void {
    this.startAt = t;
  }
  stop(t: number): void {
    this.stopAt = this.stopAt === null ? t : Math.min(this.stopAt, t);
  }
  addEventListener(_: string, fn: () => void): void {
    this.ended.push(fn);
  }
  /** Fires `ended` once the audio clock is at or past its stop. */
  endBy(now: number): boolean {
    if (this.stopAt === null || this.stopAt > now) return false;
    for (const fn of this.ended) fn();
    return true;
  }
}

class FakeBuffer {
  private data: Float32Array;
  constructor(readonly length: number) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeSource extends FakeOsc {
  buffer: FakeBuffer | null = null;
}

class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  oscillators: FakeOsc[] = [];
  gains: FakeGain[] = [];
  filters: FakeFilter[] = [];
  buffers: FakeBuffer[] = [];
  sources: FakeSource[] = [];
  // The sources not ended yet.
  private sounding = new Set<FakeOsc>();
  /** Moves the audio clock to `time`, firing `ended` on every source stopped by then. */
  advanceTo(time: number): void {
    this.currentTime = time;
    for (const source of this.sounding) if (source.endBy(time)) this.sounding.delete(source);
  }
  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer = new FakeBuffer(length);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    this.sounding.add(source);
    return source;
  }
  createOscillator(): FakeOsc {
    const osc = new FakeOsc();
    this.oscillators.push(osc);
    this.sounding.add(osc);
    return osc;
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBiquadFilter(): FakeFilter {
    const filter = new FakeFilter();
    this.filters.push(filter);
    return filter;
  }
}

function setup() {
  const ctx = new FakeContext();
  const master = new FakeGain();
  let available = true;
  const graph = (): BgmGraph | null =>
    available ? { ctx: ctx as unknown as AudioContext, output: master as unknown as AudioNode } : null;
  const bgm = new BgmPlayer(graph);
  return {
    ctx,
    master,
    bgm,
    setAvailable: (on: boolean) => (available = on),
    // The generation gain each oscillator ends up in (osc -> env [-> filter]
    // -> generation -> music gain -> master).
    genOf: (osc: FakeOsc): FakeGain => {
      const music = ctx.gains.find((g) => g.outputs[0] === master);
      let node: FakeNode = osc;
      for (;;) {
        const next = node.outputs[0];
        if (!next) throw new Error('unconnected');
        if (next.outputs[0] === music) return next as FakeGain;
        node = next;
      }
    },
  };
}

/** Runs frames every `frame` seconds over `seconds`, scheduling each time. */
function play(t: ReturnType<typeof setup>, seconds: number, remainingSec: number, track: BgmTrackId = 'tense', frame = 1 / 60): void {
  const end = t.ctx.currentTime + seconds;
  while (t.ctx.currentTime < end - 1e-9) {
    t.ctx.currentTime = Math.min(end, t.ctx.currentTime + frame);
    t.bgm.update({ want: true, visible: true, remainingSec, fadeSec: 0.05, track });
  }
}

describe('BgmPlayer — scheduling', () => {
  it('schedules nothing while not enabled, and creates no node', () => {
    const t = setup();
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: true, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    }
    expect(t.bgm.state().scheduled).toBe(0);
    expect(t.ctx.oscillators).toHaveLength(0);
    expect(t.ctx.gains).toHaveLength(0);
  });

  it('schedules nothing while not wanted (muted, paused, not playing), and nothing without audio', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    }
    expect(t.ctx.oscillators).toHaveLength(0);
    t.setAvailable(false);
    t.bgm.update({ want: true, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    expect(t.ctx.oscillators).toHaveLength(0);
    expect(t.bgm.state().playing).toBe(false);
  });

  it('schedules ahead no further than the lookahead, and never the same note twice', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    let lastMax = -Infinity;
    for (let i = 0; i < 300; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: true, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
      const s = t.bgm.state();
      // A frame that scheduled a note.
      if (s.lastBatch && s.lastBatch.now === t.ctx.currentTime) {
        expect(s.lastBatch.min).toBeGreaterThanOrEqual(s.lastBatch.now - 1e-9);
        expect(s.lastBatch.max).toBeLessThan(s.lastBatch.now + BGM_LOOKAHEAD_SEC);
        expect(s.lastBatch.min).toBeGreaterThan(lastMax);
        lastMax = s.lastBatch.max;
      }
    }
    // Each (start time, frequency) once.
    const keys = t.ctx.oscillators.map((o) => `${o.startAt!.toFixed(6)}:${o.frequency.calls[0].value}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 5 seconds at 126 BPM: about 42 steps of sixteenths, a bass note on each.
    expect(t.bgm.state().scheduled).toBeGreaterThan(10);
    expect(t.bgm.state().bpm).toBe(TENSE_BPM);
    expect(t.bgm.state().intensity).toBe(0);
  });

  it('follows the time left: intensity and tempo', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 0.5, 100);
    expect(t.bgm.state().intensity).toBe(1);
    play(t, 0.5, 60);
    expect(t.bgm.state().intensity).toBe(2);
    expect(t.bgm.state().bpm).toBe(TENSE_BPM);
    play(t, 0.5, 20);
    expect(t.bgm.state().intensity).toBe(3);
    expect(t.bgm.state().bpm).toBe(TENSE_RUSH_BPM);
  });

  it('after the clock jumps 5 seconds, schedules none in the past, only within the lookahead', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    // Intensity 2: a note on every step, so the window after the jump has some.
    play(t, 1, 60);
    const before = t.ctx.oscillators.length;
    t.ctx.currentTime += 5;
    t.bgm.update({ want: true, visible: true, remainingSec: 60, fadeSec: 0.05, track: 'tense' });
    const s = t.bgm.state();
    const now = t.ctx.currentTime;
    const added = t.ctx.oscillators.slice(before);
    expect(added.length).toBeGreaterThan(0);
    for (const osc of added) {
      expect(osc.startAt!).toBeGreaterThanOrEqual(now - 1e-9);
      expect(osc.startAt!).toBeLessThan(now + BGM_LOOKAHEAD_SEC);
    }
    expect(s.lastBatch!.min).toBeGreaterThanOrEqual(now - 1e-9);
    expect(s.lastBatch!.max).toBeLessThanOrEqual(now + BGM_LOOKAHEAD_SEC + bgmStepSeconds(TENSE_BPM));
  });

  it('schedules nothing while the page is hidden, and starts no new generation', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 0.5, 170);
    const n = t.bgm.state().scheduled;
    const gen = t.bgm.state().generation;
    for (let i = 0; i < 60; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: true, visible: false, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    }
    expect(t.bgm.state().scheduled).toBe(n);
    expect(t.bgm.state().generation).toBe(gen);
  });
});

describe('BgmPlayer — generations', () => {
  it('stopping fades only that generation to 0 and stops all its oscillators by the end of the fade', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 1, 170);
    const stopAt = t.ctx.currentTime;
    t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    expect(t.bgm.state().playing).toBe(false);
    const oldGen = t.genOf(t.ctx.oscillators[0]);
    const last = oldGen.gain.calls[oldGen.gain.calls.length - 1];
    expect(last).toEqual({ method: 'linear', value: 0, time: stopAt + 0.05 });
    for (const osc of t.ctx.oscillators) expect(osc.stopAt!).toBeLessThanOrEqual(stopAt + 0.05 + 1e-9);
    // No more scheduling once stopped.
    const n = t.bgm.state().scheduled;
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    }
    expect(t.bgm.state().scheduled).toBe(n);
  });

  for (const fade of [0.05, 0.3]) {
    it(`a restart within the ${fade}s fade gets its own gain, untouched by the old one's fade`, () => {
      const t = setup();
      t.bgm.setEnabled(true);
      play(t, 1, 170);
      const oldCount = t.ctx.oscillators.length;
      const oldGen = t.genOf(t.ctx.oscillators[0]);
      t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: fade, track: 'tense' });
      t.ctx.currentTime += fade / 2;
      t.bgm.restart('tense');
      t.bgm.update({ want: true, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
      const added = t.ctx.oscillators.slice(oldCount);
      expect(added.length).toBeGreaterThan(0);
      const newGen = t.genOf(added[0]);
      expect(newGen).not.toBe(oldGen);
      for (const osc of t.ctx.oscillators.slice(0, oldCount)) expect(t.genOf(osc)).toBe(oldGen);
      for (const osc of added) expect(t.genOf(osc)).toBe(newGen);
      // The new gain starts at the tune's own gain and has no ramp to 0 scheduled on it.
      expect(newGen.gain.value).toBe(BGM_GAIN_TENSE);
      expect(newGen.gain.calls.some((c) => c.value === 0)).toBe(false);
      expect(t.bgm.state().generation).toBe(2);
      // A restart starts from the top: the first new notes are the first step's.
      const firstStart = Math.min(...added.map((o) => o.startAt!));
      const first = added.filter((o) => o.startAt === firstStart);
      // (The kick sounds as two: its sine and its click.)
      expect(first.map((o) => o.type)).toEqual(bgmNotesForStep('tense', 0, 0).flatMap((n) => (n.part === 'kick' ? ['sine', 'triangle'] : [n.wave ?? 'sine'])));
      expect(t.bgm.state().lastBatch!.min).toBe(firstStart);
      expect(t.bgm.state().step).toBeLessThan(16);
    });
  }

  it('a resume after a pause carries on from the next bar', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 0.5, 170); // inside the first bar
    t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    t.ctx.currentTime += 1;
    t.bgm.update({ want: true, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    expect(t.bgm.state().step).toBeGreaterThanOrEqual(16);
    expect(t.bgm.state().step).toBeLessThan(20);
  });

  it("the music gain sits under the output at 1 (a factor on every tune), follows a changed level at once; each generation at its tune's own gain", () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 0.1, 170);
    const musicGain = t.ctx.gains[0];
    expect(musicGain.outputs[0]).toBe(t.master);
    expect(musicGain.gain.value).toBe(1);
    expect(t.bgm.getLevel()).toBe(1);
    t.bgm.setLevel(1.5);
    expect(musicGain.gain.calls[musicGain.gain.calls.length - 1]).toMatchObject({ method: 'target', value: 1.5 });
    expect(t.bgm.getLevel()).toBe(1.5);
    const gens: number[] = [];
    for (const track of ['tense', 'acid', 'hunt'] as const) {
      play(t, 0.3, 170, track);
      gens.push(t.genOf(t.ctx.oscillators[t.ctx.oscillators.length - 1]).gain.value);
    }
    expect(gens).toEqual([BGM_GAIN_TENSE, BGM_GAIN_ACID, BGM_GAIN_HUNT]);
    expect(musicGain.gain.value).toBe(1);
  });

  it('stop() alone, with no scheduling call after, fades that generation to 0 in 0.05s and stops its oscillators', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 1, 170);
    const gen = t.genOf(t.ctx.oscillators[0]);
    const n = gen.gain.calls.length;
    t.ctx.currentTime += 0.004; // part way between two frames
    const at = t.ctx.currentTime;
    t.bgm.stop(0.05);
    expect(t.bgm.state().playing).toBe(false);
    expect(gen.gain.calls.slice(n)).toEqual([
      { method: 'set', value: BGM_GAIN_TENSE, time: at },
      { method: 'linear', value: 0, time: at + 0.05 },
    ]);
    expect(t.bgm.state().lastStop).toEqual({ generation: 1, at, end: at + 0.05 });
    for (const osc of t.ctx.oscillators) {
      expect(osc.stopAt).not.toBeNull();
      expect(osc.stopAt!).toBeLessThanOrEqual(at + 0.05 + 1e-9);
    }
  });

  it('hide() alone fades that generation in 0.05s; back, a new generation skips the hidden time and follows the time left', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 1, 170);
    const gen = t.genOf(t.ctx.oscillators[0]);
    const at = t.ctx.currentTime;
    t.bgm.hide();
    expect(t.bgm.state().playing).toBe(false);
    expect(gen.gain.calls[gen.gain.calls.length - 1]).toEqual({ method: 'linear', value: 0, time: at + 0.05 });
    for (const osc of t.ctx.oscillators) expect(osc.stopAt!).toBeLessThanOrEqual(at + 0.05 + 1e-9);
    // Frames while hidden start nothing.
    const before = t.ctx.oscillators.length;
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: true, visible: false, remainingSec: 60, fadeSec: 0.05, track: 'tense' });
    }
    expect(t.ctx.oscillators.length).toBe(before);
    expect(t.bgm.state().generation).toBe(1);
    // Back 5 seconds later, with 60 seconds left.
    t.ctx.currentTime = at + 5;
    const stepBefore = t.bgm.state().step;
    t.bgm.update({ want: true, visible: true, remainingSec: 60, fadeSec: 0.05, track: 'tense' });
    const s = t.bgm.state();
    expect(s).toMatchObject({ playing: true, generation: 2, intensity: 2, bpm: TENSE_BPM });
    const now = t.ctx.currentTime;
    const added = t.ctx.oscillators.slice(before);
    expect(added.length).toBeGreaterThan(0);
    for (const osc of added) {
      expect(osc.startAt!).toBeGreaterThanOrEqual(now - 1e-9);
      expect(osc.startAt!).toBeLessThan(now + BGM_LOOKAHEAD_SEC);
      expect(t.genOf(osc)).not.toBe(gen);
    }
    // The first note is within a sixteenth of now: the timeline went on through the hidden time.
    expect(s.lastBatch!.min).toBeLessThan(now + bgmStepSeconds(TENSE_BPM) + 1e-9);
    expect(s.step - stepBefore).toBeGreaterThan(Math.floor(5 / bgmStepSeconds(TENSE_BPM)) - 2);
  });

  it('stop() and hide() with nothing playing do nothing', () => {
    const t = setup();
    t.bgm.stop(0.05);
    t.bgm.hide();
    t.bgm.setEnabled(true);
    t.bgm.stop(0.05);
    expect(t.bgm.state()).toMatchObject({ playing: false, generation: 0, lastStop: null });
    expect(t.ctx.gains).toHaveLength(0);
  });

  it('switching off stops at once', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 0.5, 170);
    t.bgm.setEnabled(false);
    expect(t.bgm.state().enabled).toBe(false);
    expect(t.bgm.state().playing).toBe(false);
    for (const osc of t.ctx.oscillators) expect(osc.stopAt!).toBeLessThanOrEqual(t.ctx.currentTime + 0.05 + 1e-9);
  });
});

const wanted = (remainingSec: number, track: BgmTrackId = 'tense'): BgmUpdate => ({ want: true, visible: true, remainingSec, fadeSec: 0.05, track });

describe('BgmPlayer — the drums', () => {
  // At 20 seconds left (intensity 3): a kick every beat, the hi-hat every
  // sixteenth.
  function playRush(seconds = 2) {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, seconds, 20);
    return t;
  }
  const kicks = (t: ReturnType<typeof setup>) =>
    t.ctx.oscillators.filter((o) => o.type === 'sine' && o.frequency.calls[0]?.value === BGM_KICK.fromHz);
  const envCalls = (source: FakeOsc): ParamCall[] => {
    const first = source.outputs[0];
    // A noise goes through its filter before its envelope.
    const env = first instanceof FakeFilter ? first.outputs[0] : first;
    return (env as FakeGain).gain.calls;
  };

  it('the kick: a sine scheduled to fall from 150 Hz to 45 Hz over 0.1s, rising over 0.003s, gone by 0.16s, into its generation', () => {
    const t = playRush();
    const gen = t.genOf(t.ctx.oscillators[0]);
    const all = kicks(t);
    expect(all.length).toBeGreaterThan(2);
    for (const kick of all) {
      const start = kick.startAt!;
      expect(kick.frequency.calls).toEqual([
        { method: 'set', value: 150, time: start },
        { method: 'exp', value: 45, time: start + 0.1 },
      ]);
      expect(BGM_KICK.sec).toBe(0.16);
      expect(kick.stopAt! - start).toBeCloseTo(0.16 + 0.02, 9);
      expect(envCalls(kick)).toEqual([
        { method: 'set', value: 0, time: start },
        { method: 'linear', value: 0.9, time: start + 0.003 },
        { method: 'exp', value: 0.0001, time: start + 0.16 },
      ]);
      expect(t.genOf(kick)).toBe(gen);
    }
  });

  it('over each kick, its click: a triangle falling from 1000 Hz to 250 Hz over 0.025s, gone by 0.03s, at half the kick, into its generation; both come off once ended', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 2, 170); // intensity 0: the kick from the start
    const gen = t.genOf(t.ctx.oscillators[0]);
    const all = kicks(t);
    const clicks = t.ctx.oscillators.filter((o) => o.type === 'triangle');
    expect(BGM_KICK_CLICK).toEqual({ fromHz: 1000, toHz: 250, dropSec: 0.025, sec: 0.03, level: 0.5, attack: 0.002 });
    expect(all.length).toBeGreaterThan(2);
    expect(clicks.map((c) => c.startAt)).toEqual(all.map((k) => k.startAt));
    const envPeak = (osc: FakeOsc): number => (osc.outputs[0] as FakeGain).gain.calls.find((c) => c.method === 'linear')!.value;
    for (const [i, click] of clicks.entries()) {
      const start = click.startAt!;
      expect(click.frequency.calls).toEqual([
        { method: 'set', value: 1000, time: start },
        { method: 'exp', value: 250, time: start + 0.025 },
      ]);
      expect(click.stopAt! - start).toBeCloseTo(0.03 + 0.02, 9);
      expect(envCalls(click)[1]).toEqual({ method: 'linear', value: 0.45, time: start + 0.002 });
      expect(t.genOf(click)).toBe(gen);
      expect(envPeak(click)).toBeCloseTo(envPeak(all[i]) * 0.5, 12);
    }
    // Past every stop, both sources of every kick and their envelopes have come off.
    t.bgm.stop(0.05);
    t.ctx.advanceTo(t.ctx.currentTime + 1);
    for (const osc of [...all, ...clicks]) {
      expect(osc.disconnected).toBe(true);
      expect(osc.outputs[0].disconnected).toBe(true);
    }
  });

  // A pitched note: osc -> envelope [-> low-pass] -> generation.
  const filterOf = (osc: FakeOsc): FakeFilter | null => {
    const next = osc.outputs[0].outputs[0];
    return next instanceof FakeFilter ? next : null;
  };
  const describeFilter = (f: FakeFilter | null): string =>
    f === null ? 'none' : `${f.type}:${f.frequency.calls[0].value}:q${f.Q.calls[0]?.value ?? '-'}`;
  // Played, stopped, and past every stop: every node has come off.
  function playAndRelease(track: BgmTrackId, remainingSec: number, seconds = 3) {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, seconds, remainingSec, track);
    const gen = t.genOf(t.ctx.oscillators[0]);
    const release = () => {
      t.bgm.stop(0.05);
      t.ctx.advanceTo(t.ctx.currentTime + 1);
      const made: FakeNode[] = [...t.ctx.oscillators, ...t.ctx.sources, ...t.ctx.filters, ...t.ctx.gains.slice(1)];
      expect(made.filter((n) => !n.disconnected)).toEqual([]);
      expect(t.bgm.state().liveNodes).toBe(0);
    };
    return { t, gen, release };
  }

  it('tense: the bass a sawtooth through a low-pass at 950 Hz of sharpness 5, its octave one at 1300 Hz; pitched notes rise over 0.006s', () => {
    const { t, gen, release } = playAndRelease('tense', 170);
    const saws = t.ctx.oscillators.filter((o) => o.type === 'sawtooth');
    expect(saws.length).toBeGreaterThan(40);
    expect(new Set(saws.map((o) => describeFilter(filterOf(o))))).toEqual(new Set(['lowpass:950:q5', 'lowpass:1300:q-']));
    for (const osc of saws) {
      expect(t.genOf(osc)).toBe(gen);
      expect(osc.detune.calls).toEqual([]);
      const start = osc.startAt!;
      expect((osc.outputs[0] as FakeGain).gain.calls[1]).toMatchObject({ method: 'linear', time: start + 0.006 });
    }
    // The bass and its octave start together, on every step.
    const low = saws.filter((o) => filterOf(o)!.frequency.calls[0].value === 950);
    const up = saws.filter((o) => filterOf(o)!.frequency.calls[0].value === 1300);
    expect(up.map((o) => o.startAt)).toEqual(low.map((o) => o.startAt));
    release();
  });

  it('acid: the bass a sawtooth through a low-pass of sharpness 11, opening on each beat\'s third sixteenth', () => {
    const { t, gen, release } = playAndRelease('acid', 100); // intensity 1
    const saws = t.ctx.oscillators.filter((o) => o.type === 'sawtooth');
    expect(saws.length).toBeGreaterThan(20);
    expect(new Set(saws.map((o) => describeFilter(filterOf(o))))).toEqual(new Set(['lowpass:1000:q11', 'lowpass:1500:q11']));
    for (const osc of saws) expect(t.genOf(osc)).toBe(gen);
    expect(t.bgm.state()).toMatchObject({ track: 'acid', bpm: 130 });
    release();
  });

  it('hunt: each drone two sawtooths 14 cents below and above the root and a square an octave up, together, all into the generation', () => {
    const { t, gen, release } = playAndRelease('hunt', 170);
    const saws = t.ctx.oscillators.filter((o) => o.type === 'sawtooth');
    const squares = t.ctx.oscillators.filter((o) => o.type === 'square');
    // 3 seconds at 170 BPM: a drone every half bar (0.71s).
    expect(saws.length).toBeGreaterThanOrEqual(8);
    expect(squares).toHaveLength(saws.length / 2);
    const starts = [...new Set(saws.map((o) => o.startAt!))];
    for (const start of starts) {
      const pair = saws.filter((o) => o.startAt === start);
      expect(pair.map((o) => o.detune.calls)).toEqual([[{ method: 'set', value: -14, time: start }], [{ method: 'set', value: 14, time: start }]]);
      expect(pair[0].frequency.calls[0].value).toBe(pair[1].frequency.calls[0].value);
      expect(pair.map((o) => describeFilter(filterOf(o)))).toEqual(['lowpass:520:q-', 'lowpass:520:q-']);
      const square = squares.find((o) => o.startAt === start)!;
      expect(square.frequency.calls[0].value).toBeCloseTo(pair[0].frequency.calls[0].value * 2, 9);
      expect(square.detune.calls).toEqual([]);
      expect(describeFilter(filterOf(square))).toBe('lowpass:900:q-');
    }
    for (const osc of [...saws, ...squares]) expect(t.genOf(osc)).toBe(gen);
    expect(t.bgm.state()).toMatchObject({ track: 'hunt', bpm: 170 });
    release();
  });

  it('the snare: the noise through a band-pass at 1800 Hz of sharpness 0.8, gone by 0.13s, under a triangle at 190 Hz at 0.6 of it, gone by 0.1s', () => {
    expect(BGM_SNARE).toMatchObject({ bandpassHz: 1800, q: 0.8, sec: 0.13, toneHz: 190, toneSec: 0.1, toneLevel: 0.6 });
    const { t, gen, release } = playAndRelease('hunt', 170);
    const snares = t.ctx.sources.filter((s) => (s.outputs[0] as FakeFilter).type === 'bandpass');
    // Two a bar (steps 4 and 12): 3 seconds at 170 BPM is over 2 bars.
    expect(snares.length).toBeGreaterThanOrEqual(4);
    for (const snare of snares) {
      const start = snare.startAt!;
      expect(describeFilter(snare.outputs[0] as FakeFilter)).toBe('bandpass:1800:q0.8');
      expect(snare.stopAt! - start).toBeCloseTo(0.13 + 0.02, 9);
      expect(envCalls(snare)).toEqual([
        { method: 'set', value: 0, time: start },
        { method: 'linear', value: 0.55, time: start + 0.002 },
        { method: 'exp', value: 0.0001, time: start + 0.13 },
      ]);
      expect(t.genOf(snare)).toBe(gen);
      const tone = t.ctx.oscillators.find((o) => o.type === 'triangle' && o.startAt === start && o.frequency.calls[0].value === 190)!;
      expect(tone).toBeDefined();
      expect(tone.stopAt! - start).toBeCloseTo(0.1 + 0.02, 9);
      expect(envCalls(tone)[1].value).toBeCloseTo(0.55 * 0.6, 12);
      expect(envCalls(tone)[1].time).toBeCloseTo(start + 0.002, 12);
      expect(t.genOf(tone)).toBe(gen);
    }
    release();
  });

  it('the kick with its click in every tune: a sine and a triangle starting together', () => {
    for (const track of ['tense', 'acid', 'hunt'] as const) {
      const { t, release } = playAndRelease(track, 170, 2);
      const all = kicks(t);
      expect(all.length, track).toBeGreaterThanOrEqual(2);
      const clicks = t.ctx.oscillators.filter((o) => o.type === 'triangle' && o.frequency.calls[0].value === 1000);
      expect(clicks.map((c) => c.startAt), track).toEqual(all.map((k) => k.startAt));
      release();
    }
  });

  it('the hi-hat plays the noise buffer, through a high-pass at 7000 Hz, gone by 0.035s, into its generation', () => {
    expect(BGM_HAT.sec).toBe(0.035);
    const t = playRush();
    const gen = t.genOf(t.ctx.oscillators[0]);
    expect(t.ctx.buffers).toHaveLength(1);
    const buffer = t.ctx.buffers[0];
    expect(buffer.length).toBe(t.ctx.sampleRate);
    expect(t.ctx.sources.length).toBeGreaterThan(10);
    const kinds = new Set<string>();
    for (const source of t.ctx.sources) {
      expect(source.buffer).toBe(buffer);
      expect(t.genOf(source)).toBe(gen);
      const filter = source.outputs[0] as FakeFilter;
      kinds.add(`${filter.type}:${filter.frequency.calls[0].value}`);
      expect(source.stopAt! - 0.02 - source.startAt!).toBeCloseTo(BGM_HAT.sec, 9);
    }
    expect(kinds).toEqual(new Set(['highpass:7000']));
  });

  it('the noise buffer is made once per AudioContext, the same samples each time, by a fixed calculation', () => {
    const a = playRush(1);
    play(a, 1, 20);
    a.bgm.update({ want: false, visible: true, remainingSec: 20, fadeSec: 0.05, track: 'tense' });
    play(a, 1, 20);
    expect(a.bgm.state().generation).toBe(2);
    expect(a.ctx.buffers).toHaveLength(1);
    const b = playRush(1);
    expect(b.ctx.buffers).toHaveLength(1);
    const samples = a.ctx.buffers[0].getChannelData();
    expect(b.ctx.buffers[0].getChannelData()).toEqual(samples);
    const again = new Float32Array(samples.length);
    fillBgmNoise(again);
    expect(again).toEqual(samples);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(new Set(samples).size).toBeGreaterThan(samples.length / 2);
  });

  it('stopping the generation stops its drums too, by the end of the fade', () => {
    const t = playRush();
    const at = t.ctx.currentTime;
    t.bgm.stop(0.05);
    for (const source of [...t.ctx.sources, ...t.ctx.oscillators]) expect(source.stopAt!).toBeLessThanOrEqual(at + 0.05 + 1e-9);
  });

  it('no Math.random in src/audio/', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files).toContain('bgm.ts');
    for (const file of files) expect(readFileSync(`${dir}/${file}`, 'utf8'), file).not.toMatch(/Math\.random/);
  });
});

describe('BgmPlayer — muted or off', () => {
  it('creates no sound source while switched off, not wanted (muted) or without audio', () => {
    const t = setup();
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update(wanted(20));
    }
    t.bgm.setEnabled(true);
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: false, visible: true, remainingSec: 20, fadeSec: 0.05, track: 'tense' });
    }
    t.setAvailable(false);
    t.bgm.update(wanted(20));
    expect(t.ctx.oscillators).toHaveLength(0);
    expect(t.ctx.sources).toHaveLength(0);
    expect(t.ctx.buffers).toHaveLength(0);
    expect(t.ctx.gains).toHaveLength(0);
    expect(t.bgm.state()).toMatchObject({ playing: false, scheduled: 0 });
  });
});

describe('BgmPlayer — its nodes come off once done', () => {
  // How many nodes may still be connected at once, for each tune. A note's
  // nodes are made when it is scheduled, up to BGM_LOOKAHEAD_SEC (0.2s)
  // ahead, and come off when its source ends, at its stop (its length +
  // 0.02s), seen at the next frame (1/60s). A note's nodes: a pitched note
  // 2 (oscillator, envelope) or 3 (and its low-pass); a kick 4 (its sine and
  // its click, each with an envelope); a hi-hat 3 (noise, filter, envelope);
  // a snare 5 (its noise 3, its triangle 2).
  // - The short notes last at most 0.18s (the kick, 0.16s + 0.02s), so each
  //   lives at most 0.2 + 0.18 + 1/60 = 0.397s: the notes of at most
  //   ceil(0.397 / step) steps at once.
  // - The long notes (the risers, a bar long; HUNT's drones, 7.5 steps) are
  //   counted on their own, and the generation gains — the playing one and
  //   one still fading — are 2.
  // TENSE (a step 0.119s at 126 BPM, 0.107s at 140): 4 steps at once, a step
  // at most 22 nodes (step 12 at intensity 3: kick 4, bass 3, its octave 3,
  // hi-hat 3, three stabs 9) -> 88; the riser (1.714s at 140) lives at most
  // 0.2 + 1.714 + 0.02 + 1/60 = 1.95s: 2 at once, 2 nodes each -> 4.
  // ACID (0.115s at 130, 0.104s at 144): 4 steps, a step at most 12 nodes
  // (steps 4 and 12 from intensity 2: kick 4, bass 3, snare 5) -> 48.
  // HUNT (0.088s at 170, 0.084s at 178): 5 steps, a step at most 8 nodes
  // (steps 4 and 12: snare 5, hi-hat 3) -> 40; a drone (three notes, 3 nodes
  // each, every 8 steps = 0.706s at 170) lives at most 0.2 + 0.662 + 0.02 +
  // 1/60 = 0.9s: 2 at once -> 18; the riser (1.412s at 170) at most 1.65s,
  // 2 at once -> 4.
  const LIVE_NODES_LIMIT: Readonly<Record<BgmTrackId, number>> = {
    tense: 88 + 4 + 2,
    acid: 48 + 2,
    hunt: 40 + 18 + 4 + 2,
  };

  const frame = 1 / 60;

  for (const track of ['tense', 'acid', 'hunt'] as const) {
    it(`${track}: playing 180 seconds of a run, never more than ${LIVE_NODES_LIMIT[track]} nodes connected at once; stopped, none once its last source ends`, () => {
      const t = setup();
      t.bgm.setEnabled(true);
      let max = 0;
      let frames = 0;
      for (let elapsed = 0; elapsed < 180; elapsed += frame) {
        t.ctx.advanceTo(t.ctx.currentTime + frame);
        t.bgm.update(wanted(180 - elapsed, track));
        max = Math.max(max, t.bgm.state().liveNodes);
        frames++;
      }
      const s = t.bgm.state();
      // It went through every intensity and both tempos.
      expect(s).toMatchObject({ playing: true, generation: 1, track, intensity: 3, bpm: { tense: 140, acid: 144, hunt: 178 }[track] });
      expect(frames).toBeGreaterThan(10_000);
      expect(s.scheduled).toBeGreaterThan(2_000);
      expect(max).toBeGreaterThan(0);
      expect(max).toBeLessThanOrEqual(LIVE_NODES_LIMIT[track]);
      // Far more nodes were made than were ever connected at once.
      const made = t.ctx.oscillators.length + t.ctx.sources.length + t.ctx.gains.length - 1 + t.ctx.filters.length;
      expect(made).toBeGreaterThan(LIVE_NODES_LIMIT[track] * 50);

      t.bgm.stop(0.05);
      const end = t.ctx.currentTime + 0.05;
      expect(t.bgm.state().liveNodes).toBeGreaterThan(0);
      while (t.ctx.currentTime < end + 0.05) {
        t.ctx.advanceTo(t.ctx.currentTime + frame);
        t.bgm.update({ want: false, visible: true, remainingSec: 1, fadeSec: 0.05, track });
      }
      expect(t.bgm.state().liveNodes).toBe(0);
      // Every node but the music gain was disconnected.
      const nodes: FakeNode[] = [...t.ctx.oscillators, ...t.ctx.sources, ...t.ctx.filters, ...t.ctx.gains.slice(1)];
      expect(nodes.filter((n) => !n.disconnected)).toEqual([]);
      expect(t.ctx.gains[0].disconnected).toBe(false);
    });
  }

  it('a pause, a hide, a restart and a change of tune each leave nothing connected of the generation they stop', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    const run = (seconds: number, remainingSec: number, want = true, visible = true, track: BgmTrackId = 'tense') => {
      const end = t.ctx.currentTime + seconds;
      while (t.ctx.currentTime < end - 1e-9) {
        t.ctx.advanceTo(t.ctx.currentTime + frame);
        t.bgm.update({ want, visible, remainingSec, fadeSec: 0.05, track });
      }
    };
    run(2, 20);
    run(1, 20, false); // paused
    expect(t.bgm.state().liveNodes).toBe(0);
    run(2, 20);
    run(1, 20, true, false); // hidden
    expect(t.bgm.state().liveNodes).toBe(0);
    run(2, 20);
    t.bgm.restart('tense');
    run(1, 20);
    // Only the new generation's: its gain and the notes it is sounding.
    expect(t.bgm.state().generation).toBe(4);
    expect(t.bgm.state().liveNodes).toBeLessThanOrEqual(LIVE_NODES_LIMIT.tense);
    // Into ACID, then HUNT: each change stops the generation before.
    run(2, 20, true, true, 'acid');
    run(2, 20, true, true, 'hunt');
    expect(t.bgm.state()).toMatchObject({ generation: 6, track: 'hunt' });
    expect(t.bgm.state().liveNodes).toBeLessThanOrEqual(LIVE_NODES_LIMIT.hunt);
    t.bgm.stop(0.05);
    run(0.2, 20, false, true, 'hunt');
    expect(t.bgm.state().liveNodes).toBe(0);
    const nodes: FakeNode[] = [...t.ctx.oscillators, ...t.ctx.sources, ...t.ctx.filters, ...t.ctx.gains.slice(1)];
    expect(nodes.filter((n) => !n.disconnected)).toEqual([]);
  });
});

describe('BgmPlayer — a change of tune', () => {
  it('while playing: the playing generation stops in 0.05s, a new one plays the new tune from its first bar, at the intensity for the time left and the new tempo', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 2.3, 60, 'tense'); // intensity 2, part way into the second bar
    const before = t.bgm.state();
    expect(before).toMatchObject({ playing: true, generation: 1, track: 'tense', intensity: 2, bpm: 126 });
    expect(before.step).toBeGreaterThan(16);
    const oldGen = t.genOf(t.ctx.oscillators[0]);
    const oldCount = t.ctx.oscillators.length;
    const oldSources = t.ctx.sources.length;
    t.ctx.currentTime += 0.004;
    const at = t.ctx.currentTime;
    t.bgm.setTrack('acid');
    expect(t.bgm.state()).toMatchObject({ playing: false, track: 'acid', lastStop: { generation: 1, at, end: at + 0.05 } });
    expect(oldGen.gain.calls.slice(-2)).toEqual([
      { method: 'set', value: BGM_GAIN_TENSE, time: at },
      { method: 'linear', value: 0, time: at + 0.05 },
    ]);
    for (const osc of t.ctx.oscillators) expect(osc.stopAt!).toBeLessThanOrEqual(at + 0.05 + 1e-9);
    for (const source of t.ctx.sources) expect(source.stopAt!).toBeLessThanOrEqual(at + 0.05 + 1e-9);

    // The next frame: the new generation, from ACID's first step, at the time left's intensity.
    t.bgm.update(wanted(60, 'acid'));
    const after = t.bgm.state();
    expect(after).toMatchObject({ playing: true, generation: 2, track: 'acid', intensity: 2, bpm: 130 });
    expect(after.lastBatch!.min).toBe(at);
    expect(after.step).toBeLessThan(16);
    const added = t.ctx.oscillators.slice(oldCount);
    const newGen = t.genOf(added[0]);
    expect(newGen).not.toBe(oldGen);
    expect(newGen.gain.value).toBe(BGM_GAIN_ACID);
    for (const osc of added) expect(t.genOf(osc)).toBe(newGen);
    // Its first step is ACID's step 0 at intensity 2: the kick (sine, click) and the bass on E2.
    const first = added.filter((o) => o.startAt === at);
    expect(first.map((o) => o.type)).toEqual(['sine', 'triangle', 'sawtooth']);
    expect(first[2].frequency.calls[0].value).toBeCloseTo(440 * Math.pow(2, (40 - 69) / 12), 9);
    expect(describeQ(first[2])).toBe('lowpass:1620:q11');
    // Its steps go at ACID's 130 BPM.
    const bassStarts = added.filter((o) => o.type === 'sawtooth').map((o) => o.startAt!);
    expect(bassStarts[1] - bassStarts[0]).toBeCloseTo(60 / 130 / 4, 9);
    expect(t.ctx.sources.length).toBe(oldSources);
  });

  it('a change through update() does the same: stops, then the new tune from its top in the same frame', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 1.5, 20, 'acid');
    const at = t.ctx.currentTime + 1 / 60;
    play(t, 1 / 60, 20, 'hunt');
    expect(t.bgm.state()).toMatchObject({ playing: true, generation: 2, track: 'hunt', intensity: 3, bpm: 178, lastStop: { generation: 1 } });
    expect(t.bgm.state().lastStop!.at).toBeCloseTo(at, 9);
    expect(t.bgm.state().lastBatch!.min).toBeCloseTo(at, 9);
    expect(t.bgm.state().step).toBeLessThan(16);
  });

  it('while not playing (paused, muted, switched off): makes nothing, and the next start plays the new tune from its top', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 1, 170, 'tense');
    t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'tense' });
    const made = { osc: t.ctx.oscillators.length, gains: t.ctx.gains.length, sources: t.ctx.sources.length, filters: t.ctx.filters.length };
    const gen = t.bgm.state().generation;
    t.bgm.setTrack('hunt');
    for (let i = 0; i < 30; i++) {
      t.ctx.currentTime += 1 / 60;
      t.bgm.update({ want: false, visible: true, remainingSec: 170, fadeSec: 0.05, track: 'hunt' });
    }
    expect({ osc: t.ctx.oscillators.length, gains: t.ctx.gains.length, sources: t.ctx.sources.length, filters: t.ctx.filters.length }).toEqual(made);
    expect(t.bgm.state()).toMatchObject({ playing: false, generation: gen, track: 'hunt' });
    // Switched off, too.
    t.bgm.setEnabled(false);
    t.bgm.setTrack('acid');
    t.bgm.update(wanted(170, 'acid'));
    expect(t.ctx.oscillators.length).toBe(made.osc);
    // Back on: ACID from its first bar (not the bar after the one TENSE stopped in).
    t.bgm.setEnabled(true);
    t.bgm.update(wanted(170, 'acid'));
    expect(t.bgm.state()).toMatchObject({ playing: true, generation: gen + 1, track: 'acid', bpm: 130 });
    expect(t.bgm.state().step).toBeLessThan(16);
  });

  it('the same tune again changes nothing', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 1, 170, 'tense');
    t.bgm.setTrack('tense');
    expect(t.bgm.state()).toMatchObject({ playing: true, generation: 1, lastStop: null });
  });

  it('restart(track) plays that tune from its top', () => {
    const t = setup();
    t.bgm.setEnabled(true);
    play(t, 3, 170, 'hunt');
    t.bgm.restart('tense');
    t.bgm.update(wanted(170, 'tense'));
    expect(t.bgm.state()).toMatchObject({ playing: true, generation: 2, track: 'tense', bpm: 126 });
    expect(t.bgm.state().step).toBeLessThan(16);
  });
});

function describeQ(osc: FakeOsc): string {
  const f = osc.outputs[0].outputs[0] as FakeFilter;
  return `${f.type}:${f.frequency.calls[0].value}:q${f.Q.calls[0]?.value ?? '-'}`;
}
