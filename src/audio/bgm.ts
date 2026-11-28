// The background music player: plays src/audio/bgmScore.ts on the sound
// effects' AudioContext, through its master gain (so it follows mute and the
// master level), under a level of its own (1, the debug panel's BGM factor)
// and each tune's own gain (BGM_GAIN_TENSE / ACID / HUNT, on the generation
// playing it). One tune at a time: the page names the stage's (BgmUpdate.track,
// setTrack()), and a change while it plays stops the playing generation
// (BGM_FADE_SEC) and starts the new tune from its first bar. Off until switched on:
// main.ts switches it on for every page (the debug panel's BGM switch can
// turn it off; nothing saves that). It never creates the AudioContext: while
// muted, or before a user gesture has made one, it is given none and makes
// nothing.
//
// Notes are scheduled a little ahead on the audio clock (BGM_LOOKAHEAD_SEC),
// on each rendered frame, so the music keeps time through hit stops and the
// STAGE CLEAR screen. Each play-through from a start or a resume is a
// "generation" with its own gain node: stopping fades only that gain to 0 and
// stops every sound source of it by the end of the fade, so a generation
// started right after (a retry within the GAME OVER fade, a quick resume)
// is never touched by the old one's fade. If the clock has run past the next
// note (a hidden page, a long frame), the passed notes are skipped, never
// played late in a heap. Each note's nodes come off once its source has
// ended, and a stopped generation's gain once its last one has, so playing
// through a whole run piles nothing up (BgmState.liveNodes).
//
// The page's code stops the music directly (stop(), hide()) the moment it is
// no longer wanted — a pause, GAME OVER, mute, a replay, Title, a hidden page
// — without waiting for the next rendered frame, which a hidden page never
// draws. A page hidden while the music is still wanted (STAGE CLEAR) stops
// its generation the same way; once visible again a new generation carries
// on along the same timeline, from the first sixteenth from now.
//
// The drums are made here: the kick a sine falling in pitch under a short
// falling triangle (its click), the hi-hat a high-passed noise, the snare a
// band-passed noise under a short triangle — the noise from one second made
// once per AudioContext by a fixed calculation from a fixed seed (never a
// random source), so it is the same every time.
import { BGM_FADE_SEC, BGM_LOOKAHEAD_SEC, BGM_TRACK_ORDER } from '../config';
import {
  BGM_STEPS_PER_BAR,
  bgmBpmFor,
  bgmIntensityFor,
  bgmNotesForStep,
  bgmStepSeconds,
  bgmTrackGain,
  type BgmIntensity,
  type BgmNote,
  type BgmTrackId,
} from './bgmScore';

/** Where the music plays: the sound effects' context and the node it feeds (their master gain). */
export interface BgmGraph {
  ctx: AudioContext;
  output: AudioNode;
}

export interface BgmUpdate {
  /** The music should be playing now: live play or STAGE CLEAR, not paused, not muted. */
  want: boolean;
  /** The page is visible: nothing is scheduled while it is hidden. */
  visible: boolean;
  /** The run's time left, for the intensity and the tempo. */
  remainingSec: number;
  /** The live stage's tune. */
  track: BgmTrackId;
  /** How long a stop now fades out. */
  fadeSec: number;
}

export interface BgmState {
  enabled: boolean;
  playing: boolean;
  /** How many play-throughs have started since the page loaded. */
  generation: number;
  /** The tune it plays, or plays from its next start. */
  track: BgmTrackId;
  intensity: BgmIntensity;
  bpm: number;
  /** Notes scheduled since the page loaded. */
  scheduled: number;
  /** The next step to schedule. */
  step: number;
  /**
   * Nodes it made that are still connected: each note's source, envelope and
   * filter until the source has ended, and each generation's gain until that
   * generation has stopped and its last source has ended. The music gain,
   * kept for the page's life, is not counted.
   */
  liveNodes: number;
  /** The last scheduling that scheduled any note: its notes' earliest and latest start, the audio clock then, and how many. */
  lastBatch: { min: number; max: number; now: number; count: number } | null;
  /** The last stop: which generation, the audio clock then, and when its gain reaches 0. */
  lastStop: { generation: number; at: number; end: number } | null;
}

// A pitched note's rise (seconds), unless the note gives its own; never more
// than half its length. Its length is never under MIN_NOTE_SEC.
const ATTACK = 0.006;
const MIN_NOTE_SEC = 0.03;
const STOP_TAIL = 0.02;

// The drums (seconds, Hz; `attack` their rise). The kick: a sine from 150 Hz
// down to 45 Hz over 0.1s, gone by 0.16s, with a click over its start that
// small speakers play: a triangle from 1000 Hz down to 250 Hz over 0.025s,
// gone by 0.03s, at half the kick's level. The hi-hat: the noise above
// 7000 Hz, gone by 0.035s. The snare: the noise around 1800 Hz (a band-pass,
// Q 0.8), gone by 0.13s, under a triangle at 190 Hz, at 0.6 of the snare,
// gone by 0.1s.
export const BGM_KICK = { fromHz: 150, toHz: 45, dropSec: 0.1, sec: 0.16, attack: 0.003 } as const;
export const BGM_KICK_CLICK = { fromHz: 1000, toHz: 250, dropSec: 0.025, sec: 0.03, level: 0.5, attack: 0.002 } as const;
export const BGM_HAT = { highpassHz: 7000, sec: 0.035, attack: 0.002 } as const;
export const BGM_SNARE = { bandpassHz: 1800, q: 0.8, sec: 0.13, toneHz: 190, toneSec: 0.1, toneLevel: 0.6, attack: 0.002 } as const;

// One second of noise per AudioContext, made once and shared by every
// generation's hi-hats.
const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

/** The noise's samples: a linear congruential sequence from a fixed seed, in -1..1. */
export function fillBgmNoise(data: Float32Array): void {
  let x = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    data[i] = (x / 0x100000000) * 2 - 1;
  }
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    const length = Math.max(1, Math.round(ctx.sampleRate));
    buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    fillBgmNoise(buffer.getChannelData(0));
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

interface Generation {
  /** At its tune's own gain; faded to 0 when stopped. */
  gain: GainNode;
  level: number;
  /** Every sound source of it, sounding or still to come. */
  voices: Set<AudioScheduledSourceNode>;
  stopped: boolean;
  /** Its gain has come off the music gain. */
  released: boolean;
}

export class BgmPlayer {
  private enabled = false;
  private level = 1;
  private musicGain: GainNode | null = null;
  private current: Generation | null = null;
  private generation = 0;
  private track: BgmTrackId = BGM_TRACK_ORDER[0];
  private nextStep = 0;
  private nextTime = 0;
  private stepSec = bgmStepSeconds(bgmBpmFor(this.track, Infinity));
  // Where the next start or resume begins.
  private startStep = 0;
  private intensity: BgmIntensity = 0;
  private bpm = bgmBpmFor(this.track, Infinity);
  private scheduled = 0;
  private lastBatch: BgmState['lastBatch'] = null;
  private lastStop: BgmState['lastStop'] = null;
  private liveNodes = 0;
  // Stopped by hide(): the next generation keeps the timeline (nextStep,
  // nextTime) instead of starting from `startStep` now.
  private carryOn = false;
  private ctx: AudioContext | null = null;

  /** @param getGraph Only asked for while the music is switched on and wanted, so it never creates audio on its own. */
  constructor(private readonly getGraph: () => BgmGraph | null) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The switch. Off stops at once. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stop(BGM_FADE_SEC);
  }

  getLevel(): number {
    return this.level;
  }

  /** The music's own level (a factor on every tune's own gain), applied at once. */
  setLevel(level: number): void {
    this.level = level;
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.01);
  }

  /** A run starts: the music starts again from the top of `track`. */
  restart(track: BgmTrackId): void {
    if (this.current) this.stop(BGM_FADE_SEC);
    this.track = track;
    this.startStep = 0;
    this.carryOn = false;
  }

  /**
   * The tune to play. Another tune than now: if one plays, its generation
   * stops at once (BGM_FADE_SEC); the new tune starts from its first bar at
   * the next update(). Nothing is made while nothing plays.
   */
  setTrack(track: BgmTrackId): void {
    if (track === this.track) return;
    if (this.current) this.stop(BGM_FADE_SEC);
    this.track = track;
    this.startStep = 0;
    this.carryOn = false;
  }

  /** Once per rendered frame. */
  update(u: BgmUpdate): void {
    this.setTrack(u.track);
    if (!this.enabled || !u.want) {
      this.stop(u.fadeSec);
      return;
    }
    if (!u.visible) {
      this.hide();
      return;
    }
    const graph = this.getGraph();
    if (!graph) return;
    if (!this.current) this.begin(graph);
    this.schedule(graph.ctx.currentTime, u.remainingSec);
  }

  /**
   * Stops now, without waiting for a frame: fades the playing generation to 0
   * over `fadeSec` and stops all of its sound sources (oscillators and
   * noise), sounding or still to come, by the end of the fade. The next start carries on from the bar
   * after the one playing now. Nothing to do when nothing plays.
   */
  stop(fadeSec: number): void {
    const gen = this.current;
    this.current = null;
    this.carryOn = false;
    if (!gen || !this.ctx) return;
    gen.stopped = true;
    const now = this.ctx.currentTime;
    const end = now + Math.max(0, fadeSec);
    gen.gain.gain.setValueAtTime(gen.level, now);
    gen.gain.gain.linearRampToValueAtTime(0, end);
    for (const osc of gen.voices) stopVoice(osc, end);
    if (gen.voices.size === 0) this.release(gen);
    this.lastStop = { generation: this.generation, at: now, end };
    const playingStep = Math.max(0, this.nextStep - Math.ceil((this.nextTime - now) / this.stepSec));
    this.startStep = (Math.floor(playingStep / BGM_STEPS_PER_BAR) + 1) * BGM_STEPS_PER_BAR;
  }

  /**
   * The page was hidden: stops the playing generation as stop() does, over
   * BGM_FADE_SEC, but the next generation keeps the timeline — the notes
   * the clock ran past meanwhile are skipped, and it carries on from the
   * first sixteenth from then, at the time left then.
   */
  hide(): void {
    if (!this.current) return;
    this.stop(BGM_FADE_SEC);
    this.carryOn = true;
  }

  state(): BgmState {
    return {
      enabled: this.enabled,
      playing: this.current !== null,
      generation: this.generation,
      track: this.track,
      intensity: this.intensity,
      bpm: this.bpm,
      scheduled: this.scheduled,
      step: this.nextStep,
      liveNodes: this.liveNodes,
      lastBatch: this.lastBatch ? { ...this.lastBatch } : null,
      lastStop: this.lastStop ? { ...this.lastStop } : null,
    };
  }

  private begin(graph: BgmGraph): void {
    const { ctx } = graph;
    this.ctx = ctx;
    if (!this.musicGain) {
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = this.level;
      this.musicGain.connect(graph.output);
    }
    const gain = ctx.createGain();
    const level = bgmTrackGain(this.track);
    gain.gain.value = level;
    gain.connect(this.musicGain);
    this.current = { gain, level, voices: new Set(), stopped: false, released: false };
    this.liveNodes++;
    this.generation++;
    // After hide(), schedule() skips the steps the clock has run past.
    if (!this.carryOn) {
      this.nextStep = this.startStep;
      this.nextTime = ctx.currentTime;
    }
    this.carryOn = false;
  }

  private schedule(now: number, remainingSec: number): void {
    const gen = this.current;
    if (!gen || !this.ctx) return;
    this.intensity = bgmIntensityFor(remainingSec);
    this.bpm = bgmBpmFor(this.track, remainingSec);
    this.stepSec = bgmStepSeconds(this.bpm);
    // The clock ran past the next note: skip to the first step from now.
    if (this.nextTime < now) {
      const behind = Math.ceil((now - this.nextTime) / this.stepSec - 1e-9);
      this.nextStep += behind;
      this.nextTime += behind * this.stepSec;
    }
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    while (this.nextTime < now + BGM_LOOKAHEAD_SEC) {
      for (const note of bgmNotesForStep(this.track, this.nextStep, this.intensity)) {
        this.playNote(gen, note, this.nextTime);
        min = Math.min(min, this.nextTime);
        max = Math.max(max, this.nextTime);
        count++;
      }
      this.nextStep++;
      this.nextTime += this.stepSec;
    }
    if (count > 0) {
      this.scheduled += count;
      this.lastBatch = { min, max, now, count };
    }
  }

  private playNote(gen: Generation, note: BgmNote, start: number): void {
    if (note.part === 'kick') return this.playKick(gen, note, start);
    if (note.part === 'hat') return this.playHat(gen, note, start);
    if (note.part === 'snare') return this.playSnare(gen, note, start);
    const ctx = this.ctx!;
    const duration = Math.max(MIN_NOTE_SEC, note.steps * this.stepSec);
    const osc = ctx.createOscillator();
    const env = this.envelope(note.gain, start, Math.min(note.attack ?? ATTACK, duration / 2), duration);
    osc.type = note.wave ?? 'sine';
    osc.frequency.setValueAtTime(note.freq, start);
    if (note.detune !== undefined) osc.detune.setValueAtTime(note.detune, start);
    const nodes: AudioNode[] = [osc, env];
    osc.connect(env);
    if (note.filterHz !== undefined) {
      const filter = this.filter('lowpass', note.filterHz, start, note.q);
      env.connect(filter).connect(gen.gain);
      nodes.push(filter);
    } else {
      env.connect(gen.gain);
    }
    this.startVoice(gen, osc, start, duration, nodes);
  }

  // A sine from BGM_KICK.fromHz down to toHz, and over its start a short
  // triangle (BGM_KICK_CLICK) falling from 1000 Hz, each its own source.
  private playKick(gen: Generation, note: BgmNote, start: number): void {
    const kick = BGM_KICK;
    this.playSweep(gen, 'sine', kick.fromHz, kick.toHz, kick.dropSec, kick.sec, kick.attack, note.gain, start);
    const click = BGM_KICK_CLICK;
    this.playSweep(gen, 'triangle', click.fromHz, click.toHz, click.dropSec, click.sec, click.attack, note.gain * click.level, start);
  }

  // An oscillator falling from `fromHz` to `toHz` over `dropSec`, gone by `sec`.
  private playSweep(
    gen: Generation,
    wave: OscillatorType,
    fromHz: number,
    toHz: number,
    dropSec: number,
    sec: number,
    attack: number,
    gain: number,
    start: number
  ): void {
    const osc = this.ctx!.createOscillator();
    const env = this.envelope(gain, start, attack, sec);
    osc.type = wave;
    osc.frequency.setValueAtTime(fromHz, start);
    osc.frequency.exponentialRampToValueAtTime(toHz, start + dropSec);
    osc.connect(env).connect(gen.gain);
    this.startVoice(gen, osc, start, sec, [osc, env]);
  }

  // The noise above BGM_HAT.highpassHz.
  private playHat(gen: Generation, note: BgmNote, start: number): void {
    this.playNoise(gen, 'highpass', BGM_HAT.highpassHz, undefined, BGM_HAT.sec, BGM_HAT.attack, note.gain, start);
  }

  // The noise around BGM_SNARE.bandpassHz, and under it a short triangle at
  // BGM_SNARE.toneHz, each its own source.
  private playSnare(gen: Generation, note: BgmNote, start: number): void {
    const snare = BGM_SNARE;
    this.playNoise(gen, 'bandpass', snare.bandpassHz, snare.q, snare.sec, snare.attack, note.gain, start);
    this.playSweep(gen, 'triangle', snare.toneHz, snare.toneHz, snare.toneSec, snare.toneSec, snare.attack, note.gain * snare.toneLevel, start);
  }

  // The noise through a filter, gone by `sec`.
  private playNoise(gen: Generation, type: BiquadFilterType, hz: number, q: number | undefined, sec: number, attack: number, gain: number, start: number): void {
    const source = this.noise();
    const filter = this.filter(type, hz, start, q);
    const env = this.envelope(gain, start, attack, sec);
    source.connect(filter).connect(env).connect(gen.gain);
    this.startVoice(gen, source, start, sec, [source, filter, env]);
  }

  private noise(): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx);
    return source;
  }

  // `q` its sharpness, or the filter's own.
  private filter(type: BiquadFilterType, hz: number, start: number, q?: number): BiquadFilterNode {
    const filter = this.ctx!.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(hz, start);
    if (q !== undefined) filter.Q.setValueAtTime(q, start);
    return filter;
  }

  // Rises to `gain` over `attack`, gone by `duration`.
  private envelope(gain: number, start: number, attack: number, duration: number): GainNode {
    const env = this.ctx!.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    return env;
  }

  // Starts a source of the generation, stopped after `duration`; once ended,
  // its nodes (source, envelope, filter) come off, and the generation's gain
  // with the last of a stopped one.
  private startVoice(gen: Generation, source: AudioScheduledSourceNode, start: number, duration: number, nodes: AudioNode[]): void {
    source.start(start);
    source.stop(start + duration + STOP_TAIL);
    gen.voices.add(source);
    this.liveNodes += nodes.length;
    source.addEventListener('ended', () => {
      if (!gen.voices.delete(source)) return;
      for (const node of nodes) node.disconnect();
      this.liveNodes -= nodes.length;
      if (gen.stopped && gen.voices.size === 0) this.release(gen);
    });
  }

  // A stopped generation's gain comes off the music gain, once.
  private release(gen: Generation): void {
    if (gen.released) return;
    gen.released = true;
    gen.gain.disconnect();
    this.liveNodes--;
  }
}

// Stops a sound source by `time` (earlier than its own stop, never later).
function stopVoice(source: AudioScheduledSourceNode, time: number): void {
  try {
    source.stop(time);
  } catch {
    // Already stopped: nothing more to do.
  }
}
