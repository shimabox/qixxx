// Web Audio SE engine (docs/plan.md §3.8): every sound is synthesized at
// runtime with oscillators + gain envelopes — no audio asset files, no
// external libraries. This module is the ONLY place besides main.ts allowed
// to touch AudioContext; src/core/ never imports it and never references
// AudioContext itself (see core/events.ts for the plain-data bridge this
// consumes). DOM/Web Audio-dependent by design, exactly like
// render/renderer.ts and input/keyboard.ts are DOM-dependent by design.
import type { GameEvent } from '../core/events';
import type { LineSpeed } from '../core/claim';
import {
  SFX_MASTER_GAIN,
  SFX_DRAW_GAIN,
  SFX_DRAW_FREQ_FAST,
  SFX_DRAW_FREQ_SLOW,
  SFX_AREA_CLAIMED_FREQ,
  SFX_AREA_CLAIMED_DURATION,
  SFX_MISS_FREQ,
  SFX_MISS_DURATION,
  SFX_STAGE_CLEAR_NOTES,
  SFX_STAGE_CLEAR_NOTE_DURATION,
  SFX_SPLIT_CLEAR_NOTES,
  SFX_SPLIT_CLEAR_NOTE_DURATION,
  SFX_IGNITER_SPAWN_FREQ,
  SFX_IGNITER_SPAWN_DURATION,
  SFX_IGNITER_APPROACH_FREQ,
  SFX_IGNITER_APPROACH_DURATION,
  SFX_EMBER_SPAWN_FREQ,
  SFX_EMBER_SPAWN_DURATION,
  SFX_EMBER_DESPAWN_FREQ,
  SFX_EMBER_DESPAWN_DURATION,
} from '../config';

// Safari (incl. iOS) still only exposes `webkitAudioContext` in some
// versions — this is the one place that constant needs acknowledging.
type AudioContextCtor = typeof AudioContext;
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: AudioContextCtor;
}

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muted: boolean;
  private drawOsc: OscillatorNode | null = null;
  private drawGain: GainNode | null = null;
  private drawing = false;

  /** @param initialMuted Seeded from src/storage/settings.ts by main.ts. */
  constructor(initialMuted = false) {
    this.muted = initialMuted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : SFX_MASTER_GAIN, this.ctx.currentTime, 0.01);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Must be called from within a user-gesture handler (docs/plan.md §3.8:
   * mobile autoplay restrictions) — creates the AudioContext on first call
   * and resumes it if the browser started it suspended. Safe to call
   * repeatedly (e.g. on every keydown/pointerdown) since subsequent calls
   * are no-ops once the context is already running.
   */
  resume(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
  }

  /**
   * Drives the continuous line-drawing drone (docs/plan.md §3.8: "ライン引
   * き中(速度で音程差)"). Called every frame with the marker's current
   * drawing state — starts/stops/retunes an oscillator rather than firing
   * one-shot notes, so it behaves like a sustained tone, not a repeated
   * click.
   */
  setDrawing(active: boolean, speed: LineSpeed | null): void {
    if (!active || this.muted) {
      this.stopDrawTone();
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const freq = speed === 'slow' ? SFX_DRAW_FREQ_SLOW : SFX_DRAW_FREQ_FAST;
    if (!this.drawOsc || !this.drawGain) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(SFX_DRAW_GAIN, ctx.currentTime + 0.02);
      osc.connect(gain).connect(this.masterGain);
      osc.start();
      this.drawOsc = osc;
      this.drawGain = gain;
      this.drawing = true;
    } else {
      this.drawOsc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.03);
    }
  }

  /** Consumes GameEvents (docs/plan.md §3.8/§9.9) drained from GameSession, playing the matching one-shot SE for each. */
  handleEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event) {
        case 'area-claimed':
          this.playAreaClaimed();
          break;
        case 'stage-clear':
          this.playStageClear();
          break;
        case 'split-clear':
          this.playSplitClear();
          break;
        case 'miss':
          this.playMiss();
          break;
        case 'igniter-spawned':
          this.playTone(SFX_IGNITER_SPAWN_FREQ, SFX_IGNITER_SPAWN_DURATION, 'sawtooth', 0.18);
          break;
        case 'igniter-approaching':
          this.playTone(SFX_IGNITER_APPROACH_FREQ, SFX_IGNITER_APPROACH_DURATION, 'square', 0.1);
          break;
        case 'ember-spawned':
          this.playTone(SFX_EMBER_SPAWN_FREQ, SFX_EMBER_SPAWN_DURATION, 'triangle', 0.15);
          break;
        case 'ember-despawned':
          this.playTone(SFX_EMBER_DESPAWN_FREQ, SFX_EMBER_DESPAWN_DURATION, 'sine', 0.15, /* descend */ true);
          break;
      }
    }
  }

  dispose(): void {
    this.stopDrawTone();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
    }
  }

  private playAreaClaimed(): void {
    this.playTone(SFX_AREA_CLAIMED_FREQ, SFX_AREA_CLAIMED_DURATION, 'triangle', 0.22);
  }

  private playMiss(): void {
    this.playTone(SFX_MISS_FREQ, SFX_MISS_DURATION, 'sawtooth', 0.25, /* descend */ true);
  }

  private playStageClear(): void {
    this.playArpeggio(SFX_STAGE_CLEAR_NOTES, SFX_STAGE_CLEAR_NOTE_DURATION, 'triangle', 0.22);
  }

  private playSplitClear(): void {
    this.playArpeggio(SFX_SPLIT_CLEAR_NOTES, SFX_SPLIT_CLEAR_NOTE_DURATION, 'square', 0.2);
  }

  private playArpeggio(notes: readonly number[], noteDuration: number, type: OscillatorType, gain: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    notes.forEach((freq, i) => {
      this.playTone(freq, noteDuration, type, gain, false, ctx.currentTime + i * noteDuration);
    });
  }

  /**
   * A single self-contained oscillator + gain-envelope "note": ramps up
   * quickly, decays to silence over `duration`, then disconnects itself —
   * each call creates and tears down its own nodes, so overlapping one-shot
   * SEs (e.g. an area-claimed chime while an Igniter approach beep is still
   * ringing) never fight over shared state.
   */
  private playTone(
    freq: number,
    duration: number,
    type: OscillatorType = 'sine',
    gain = 0.2,
    descend = false,
    startTime?: number
  ): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const start = startTime ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (descend) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.4), start + duration);
    }

    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(env).connect(this.masterGain);
    osc.start(start);
    osc.stop(start + duration + 0.02);
    osc.addEventListener('ended', () => osc.disconnect());
  }

  private stopDrawTone(): void {
    if (this.drawOsc && this.drawGain && this.ctx) {
      const ctx = this.ctx;
      const osc = this.drawOsc;
      this.drawGain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      osc.stop(ctx.currentTime + 0.08);
    }
    this.drawOsc = null;
    this.drawGain = null;
    this.drawing = false;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const w = window as WindowWithWebkitAudio;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;

    this.ctx = new Ctor();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : SFX_MASTER_GAIN;
    this.masterGain.connect(this.ctx.destination);
    return this.ctx;
  }

  /** True while the continuous line-drawing drone is currently sounding (test/inspection hook). */
  isDrawingToneActive(): boolean {
    return this.drawing;
  }
}
