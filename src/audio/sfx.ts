// Web Audio SE engine (docs/plan.md §3.8): every sound is synthesized at
// runtime with oscillators + gain envelopes — no audio asset files, no
// external libraries. This module is the ONLY place besides main.ts allowed
// to touch AudioContext; src/core/ never imports it and never references
// AudioContext itself (see core/events.ts for the plain-data bridge this
// consumes). DOM/Web Audio-dependent by design, exactly like
// render/renderer.ts and input/keyboard.ts are DOM-dependent by design.
import type { GameEvent } from '../core/events';
import type { LineSpeed } from '../core/claim';
import type { TimeWarningCue } from '../timeWarningCue';
import { classifyClaimShare, fxParams } from '../fx/params';
import { sfxLevels, sfxPeak } from './sfxLevels';
import {
  SFX_DRAW_FREQ_FAST,
  SFX_DRAW_FREQ_SLOW,
  SFX_DEFAULT_ATTACK,
  SFX_IMPACT_ATTACK,
  SFX_TONE_STOP_TAIL,
  SFX_CLAIM_HIT_FREQ,
  SFX_CLAIM_HIT_DURATION,
  SFX_CLAIM_LOW_MID_FREQ,
  SFX_CLAIM_LOW_LARGE_FREQ,
  SFX_CLAIM_LOW_DURATION,
  SFX_CLAIM_RISE_FREQ_START,
  SFX_CLAIM_RISE_FREQ_END_FAST,
  SFX_CLAIM_RISE_FREQ_END_SLOW,
  SFX_CLAIM_RISE_DURATION,
  SFX_SPLIT_IMPACT_FREQ,
  SFX_SPLIT_IMPACT_DURATION,
  SFX_MISS_FREQ,
  SFX_MISS_OVERTONE_FREQ,
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
  SFX_EMBER_DESPAWN_END_FREQ,
  SFX_EMBER_DESPAWN_DURATION,
  SFX_EMBER_BLAZE_SPAWN_FREQ,
  SFX_EMBER_BLAZE_SPAWN_DURATION,
  SFX_EMBER_ENTERED_LINE_NOTES,
  SFX_EMBER_ENTERED_LINE_NOTE_DURATION,
  SFX_TIME_WARNING_ALARM_FREQ_START,
  SFX_TIME_WARNING_ALARM_FREQ_END,
  SFX_TIME_WARNING_ALARM_DURATION,
  SFX_TIME_WARNING_BEEP_FREQ,
  SFX_TIME_WARNING_BEEP_HIGH_FREQ,
  SFX_TIME_WARNING_BEEP_DURATION,
  SFX_WISP_SURGE_1_FREQ,
  SFX_WISP_SURGE_2_FREQ,
  SFX_WISP_SURGE_RISE,
  SFX_WISP_SURGE_DURATION,
  SFX_GAMEOVER_HIT_FREQ,
  SFX_GAMEOVER_HIT_DURATION,
  SFX_GAMEOVER_LIFE_NOTES,
  SFX_GAMEOVER_TIME_NOTES,
  SFX_GAMEOVER_NOTE_DURATION,
  SFX_COUNT_TICK_FREQ,
  SFX_COUNT_TICK_DURATION,
  SFX_COUNT_END_NOTES,
  SFX_COUNT_END_NOTE_DURATION,
  SFX_NEW_RECORD_NOTES,
  SFX_NEW_RECORD_NOTE_DURATION,
  SFX_LOG_MAX,
  GAMEOVER_COUNT_TICK_EVERY,
  TICK_RATE,
} from '../config';

// Safari (incl. iOS) still only exposes `webkitAudioContext` in some
// versions — this is the one place that constant needs acknowledging.
type AudioContextCtor = typeof AudioContext;
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: AudioContextCtor;
}

/** Semitones the claim sound rises per step of a chain of claims. */
const CHAIN_SEMITONES_PER_STEP = 2;

/**
 * The claim sound's pitch multiplier at `chain` (1 for the first claim of a
 * row): two semitones higher per further claim, capped at `maxSteps` steps.
 */
export function claimChainPitch(chain: number, maxSteps: number): number {
  const steps = Math.max(0, Math.min(Math.floor(chain) - 1, Math.floor(maxSteps)));
  return Math.pow(2, (steps * CHAIN_SEMITONES_PER_STEP) / 12);
}

/**
 * Every name a sound is recorded under (getLog(), window.__game__.getSfxLog()).
 * record() only takes these, so a new sound has to be added here — which
 * puts it under the tests that walk this table (src/audio/sfx.test.ts).
 */
export const SFX_LOG_NAMES = [
  'claim-small',
  'claim-mid',
  'claim-large',
  'split',
  'miss',
  'stage-clear',
  'gameover-life',
  'gameover-time',
  'count',
  'count-tick',
  'count-end',
  'new-record',
  'alarm',
  'beep',
  'beep-high',
  'wisp-surge-1',
  'wisp-surge-2',
  'igniter-spawn',
  'igniter-approach',
  'ember-spawn',
  'blaze-spawn',
  'ember-line',
  'ember-out',
  'draw',
] as const;

export type SfxLogName = (typeof SFX_LOG_NAMES)[number];

/** Where a falling one-shot (miss, the split thump, the GAME OVER hit) ends its glide from `freq`. */
function descendFrom(freq: number): number {
  return Math.max(20, freq * 0.4);
}

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muted: boolean;
  private drawOsc: OscillatorNode | null = null;
  private drawGain: GainNode | null = null;
  private drawing = false;
  private readonly log: SfxLogName[] = [];

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
      this.masterGain.gain.setTargetAtTime(muted ? 0 : sfxLevels.master, this.ctx.currentTime, 0.01);
    }
  }

  /**
   * Puts the master gain at `sfxLevels.master` now (0 while muted), so a
   * changed master applies to the sounds already ringing too.
   */
  applyMasterLevel(): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : sfxLevels.master, this.ctx.currentTime, 0.01);
    }
  }

  /**
   * The context and the master gain, for the music (src/audio/bgm.ts) to
   * play through — null while muted, so nothing is created to sound, and
   * null until a user gesture has created the context (resume()), so the
   * music never creates it on its own.
   */
  getAudioGraph(): { ctx: AudioContext; output: AudioNode } | null {
    if (this.muted) return null;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return null;
    this.resumeIfSuspended(ctx);
    return { ctx, output: this.masterGain };
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
   *
   * iOS Safari/Chrome for iOS (both WebKit under the hood) need one extra
   * step here beyond `ctx.resume()`: some WebKit builds keep the hardware
   * audio output itself gated even after the AudioContext reports
   * `state === 'running'`, until a buffer has actually been played through
   * it at least once from directly within a user-gesture call stack. See
   * `unlockAudioOutput()` for the fix.
   *
   * The unlock is repeated on every call until the context reports
   * `running`, not just attempted once: iOS only honours it from events it
   * counts as a user activation (`touchend`/`pointerup`/`click`, not a touch
   * `pointerdown`), and main.ts calls this from both kinds. A single attempt
   * spent on a non-activating event would leave audio locked for the whole
   * session.
   */
  resume(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      this.unlockAudioOutput(ctx);
    }
    this.resumeIfSuspended(ctx);
  }

  /**
   * `ctx.resume()` is async (a Promise) and the call sites here don't await
   * it — including this one, deliberately, since `resume()` must stay
   * synchronous to run inside a user-gesture call stack (see
   * `unlockAudioOutput()`). On iOS that Promise can take a couple hundred ms
   * to settle, so `state` can still read `'suspended'` for a moment after
   * `resume()` returns. If the very first SE of a session (`playTone()` via
   * `handleEvents()`, or the draw drone via `setDrawing()`) fires during that
   * window, WebKit silently drops it — the context isn't actually running
   * yet — even though every subsequent sound plays fine once the Promise
   * resolves. That's the "first sound didn't play, but it worked after that"
   * report from GitHub #4. Retrying `ctx.resume()` at every sound-producing
   * call site (not just the original user-gesture `resume()`) closes that
   * window: worst case it's a harmless no-op call on an already-resuming
   * context.
   */
  private resumeIfSuspended(ctx: AudioContext): void {
    // iOS also reports a non-standard 'interrupted' state (e.g. after a call
    // or returning from the background), which needs the same resume().
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      void ctx.resume();
    }
  }

  /**
   * iOS WebKit Web Audio "unlock" workaround: plays a single silent sample
   * through a throwaway AudioBufferSourceNode. This is a well-known pattern
   * for unsticking WebKit's audio output gate on first user interaction —
   * `ctx.resume()` alone is not always sufficient on iOS. Must be invoked
   * synchronously within the user-gesture call stack (it is, from
   * `resume()`); we deliberately don't await anything before calling
   * `start()`.
   *
   * The buffer is 1 sample of silence (`createBuffer(1, 1, 22050)`) so it
   * has no audible output and no effect on pitch/timing/volume of any other
   * sound — safe to run unconditionally on every platform, including
   * desktop browsers where it's a harmless no-op.
   */
  private unlockAudioOutput(ctx: AudioContext): void {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
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
    this.resumeIfSuspended(ctx);

    const freq = speed === 'slow' ? SFX_DRAW_FREQ_SLOW : SFX_DRAW_FREQ_FAST;
    if (!this.drawOsc || !this.drawGain) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(sfxPeak('draw'), ctx.currentTime + 0.02);
      osc.connect(gain).connect(this.masterGain);
      osc.start();
      this.drawOsc = osc;
      this.drawGain = gain;
      this.drawing = true;
      this.record('draw');
    } else {
      this.drawOsc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.03);
    }
  }

  /**
   * Consumes GameEvents (docs/plan.md §3.8/§9.9) drained from GameSession,
   * playing the matching one-shot SE for each. 'area-claimed' and
   * 'split-clear' are silent here: their sounds depend on the claim's size
   * and speed, so main.ts plays them from the claim notice instead
   * (playClaim() / playSplitImpact()).
   */
  handleEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event) {
        case 'area-claimed':
        case 'split-clear':
          break;
        case 'stage-clear':
          if (this.record('stage-clear')) this.playStageClear();
          break;
        case 'miss':
          if (this.record('miss')) this.playMiss();
          break;
        case 'igniter-spawned':
          if (this.record('igniter-spawn')) this.playTone(SFX_IGNITER_SPAWN_FREQ, SFX_IGNITER_SPAWN_DURATION, 'sawtooth', sfxPeak('igniter-spawn'));
          break;
        case 'igniter-approaching':
          if (this.record('igniter-approach')) this.playTone(SFX_IGNITER_APPROACH_FREQ, SFX_IGNITER_APPROACH_DURATION, 'square', sfxPeak('igniter-approach'));
          break;
        case 'ember-spawned':
          if (this.record('ember-spawn')) this.playTone(SFX_EMBER_SPAWN_FREQ, SFX_EMBER_SPAWN_DURATION, 'square', sfxPeak('ember-spawn'));
          break;
        case 'ember-blaze-spawned':
          if (this.record('blaze-spawn')) this.playTone(SFX_EMBER_BLAZE_SPAWN_FREQ, SFX_EMBER_BLAZE_SPAWN_DURATION, 'sawtooth', sfxPeak('blaze-spawn'));
          break;
        case 'ember-entered-line':
          if (this.record('ember-line')) this.playArpeggio(SFX_EMBER_ENTERED_LINE_NOTES, SFX_EMBER_ENTERED_LINE_NOTE_DURATION, 'square', sfxPeak('ember-entered-line'));
          break;
        case 'ember-despawned':
          if (!this.record('ember-out')) break;
          this.playTone(
            SFX_EMBER_DESPAWN_FREQ,
            SFX_EMBER_DESPAWN_DURATION,
            'triangle',
            sfxPeak('ember-despawn'),
            SFX_EMBER_DESPAWN_END_FREQ
          );
          break;
      }
    }
  }

  /**
   * Plays one TIME countdown warning cue. Not a GameEvent: src/timeWarningCue.ts
   * decides the tick from the live session's remaining time and main.ts
   * calls this directly, so a replay's session can never trigger it.
   */
  playTimeWarning(cue: TimeWarningCue): void {
    if (!this.record(cue)) return;
    switch (cue) {
      case 'alarm':
        this.playTone(
          SFX_TIME_WARNING_ALARM_FREQ_START,
          SFX_TIME_WARNING_ALARM_DURATION,
          'square',
          sfxPeak('time-alarm'),
          SFX_TIME_WARNING_ALARM_FREQ_END
        );
        break;
      case 'beep':
        this.playTone(SFX_TIME_WARNING_BEEP_FREQ, SFX_TIME_WARNING_BEEP_DURATION, 'square', sfxPeak('time-beep'));
        break;
      case 'beep-high':
        this.playTone(SFX_TIME_WARNING_BEEP_HIGH_FREQ, SFX_TIME_WARNING_BEEP_DURATION, 'square', sfxPeak('time-beep'));
        break;
    }
  }

  /**
   * The Wisp surge: one short rising sawtooth as a claim raises the surge
   * level to `level`, higher for level 2. Not a GameEvent: main.ts plays it
   * from the live session's surge notice, so a replay's session and the
   * Title demo never trigger it.
   */
  playWispSurge(level: 1 | 2): void {
    if (!this.record(`wisp-surge-${level}`)) return;
    const freq = level === 2 ? SFX_WISP_SURGE_2_FREQ : SFX_WISP_SURGE_1_FREQ;
    this.playTone(freq, SFX_WISP_SURGE_DURATION, 'sawtooth', sfxPeak('wisp-surge'), freq * SFX_WISP_SURGE_RISE);
  }

  dispose(): void {
    this.stopDrawTone();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
    }
  }

  /**
   * The area-claim sound: a short hit that peaks at once, with a low layer
   * under a mid-size (around 220 Hz) or large (around 110 Hz) claim, then a
   * sweep rising while the new area fills in (higher for a slow line).
   * `share` is the occupancy the claim added (0-1), sized the same way as
   * the visual feedback (src/fx/params.ts). `chain` is the claim's place in
   * a row of claims (src/fx/director.ts): from the second, the hit and the
   * sweep rise two semitones per step, up to chainPitchMaxSteps steps, so a
   * run of claims climbs. The low layer keeps its pitch.
   */
  playClaim({ share, speed, chain = 1 }: { share: number; speed: LineSpeed; chain?: number }): void {
    const size = classifyClaimShare(share, fxParams);
    if (!this.record(`claim-${size}`)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const pitch = claimChainPitch(chain, fxParams.chainPitchMaxSteps);
    this.playTone(SFX_CLAIM_HIT_FREQ * pitch, SFX_CLAIM_HIT_DURATION, 'triangle', sfxPeak('claim-hit'), undefined, now, SFX_IMPACT_ATTACK);
    if (size !== 'small') {
      const lowFreq = size === 'large' ? SFX_CLAIM_LOW_LARGE_FREQ : SFX_CLAIM_LOW_MID_FREQ;
      this.playTone(lowFreq, SFX_CLAIM_LOW_DURATION, 'square', sfxPeak('claim-low'), undefined, now, SFX_IMPACT_ATTACK);
    }
    const riseEnd = speed === 'slow' ? SFX_CLAIM_RISE_FREQ_END_SLOW : SFX_CLAIM_RISE_FREQ_END_FAST;
    this.playTone(
      SFX_CLAIM_RISE_FREQ_START * pitch,
      SFX_CLAIM_RISE_DURATION,
      'triangle',
      sfxPeak('claim-rise'),
      riseEnd * pitch,
      now + SFX_CLAIM_HIT_DURATION
    );
  }

  /** The split sound: a low, short thump, then the split arpeggio. */
  playSplitImpact(): void {
    if (!this.record('split')) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playTone(
      SFX_SPLIT_IMPACT_FREQ,
      SFX_SPLIT_IMPACT_DURATION,
      'square',
      sfxPeak('split-impact'),
      descendFrom(SFX_SPLIT_IMPACT_FREQ),
      now,
      SFX_IMPACT_ATTACK
    );
    this.playArpeggio(
      SFX_SPLIT_CLEAR_NOTES,
      SFX_SPLIT_CLEAR_NOTE_DURATION,
      'square',
      sfxPeak('split-clear'),
      now + SFX_SPLIT_IMPACT_DURATION,
      SFX_IMPACT_ATTACK
    );
  }

  /**
   * The miss: a low sawtooth falling from 90 Hz, with a quieter one an octave
   * up falling alongside it — small speakers drop the low one, not the layer.
   */
  private playMiss(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playTone(
      SFX_MISS_FREQ,
      SFX_MISS_DURATION,
      'sawtooth',
      sfxPeak('miss'),
      descendFrom(SFX_MISS_FREQ),
      now,
      SFX_IMPACT_ATTACK
    );
    this.playTone(
      SFX_MISS_OVERTONE_FREQ,
      SFX_MISS_DURATION,
      'sawtooth',
      sfxPeak('miss-overtone'),
      descendFrom(SFX_MISS_OVERTONE_FREQ),
      now,
      SFX_IMPACT_ATTACK
    );
  }

  private playStageClear(): void {
    this.playArpeggio(
      SFX_STAGE_CLEAR_NOTES,
      SFX_STAGE_CLEAR_NOTE_DURATION,
      'triangle',
      sfxPeak('stage-clear'),
      undefined,
      SFX_IMPACT_ATTACK
    );
  }

  /**
   * The GAME OVER close: a low, falling hit, then three notes resolving
   * upward — different for a lost last life and for TIME UP!, and never a
   * sad fall, so it reads as an end that invites another run.
   */
  playGameOver(reason: 'life' | 'time'): void {
    if (!this.record(`gameover-${reason}`)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playTone(
      SFX_GAMEOVER_HIT_FREQ,
      SFX_GAMEOVER_HIT_DURATION,
      'square',
      sfxPeak('gameover'),
      descendFrom(SFX_GAMEOVER_HIT_FREQ),
      now,
      SFX_IMPACT_ATTACK
    );
    this.playArpeggio(
      reason === 'time' ? SFX_GAMEOVER_TIME_NOTES : SFX_GAMEOVER_LIFE_NOTES,
      SFX_GAMEOVER_NOTE_DURATION,
      'triangle',
      sfxPeak('gameover'),
      now + SFX_GAMEOVER_HIT_DURATION
    );
  }

  /** One tick of the GAME OVER score count-up. */
  playCountTick(): void {
    if (!this.record('count-tick')) return;
    this.playTone(SFX_COUNT_TICK_FREQ, SFX_COUNT_TICK_DURATION, 'triangle', sfxPeak('count-tick'));
  }

  /** The GAME OVER score count-up stopping on the final score. */
  playCountEnd(): void {
    if (!this.record('count-end')) return;
    this.playArpeggio(SFX_COUNT_END_NOTES, SFX_COUNT_END_NOTE_DURATION, 'triangle', sfxPeak('count-end'));
  }

  /** A beaten best on the GAME OVER screen: a bright rising fanfare. */
  playNewRecord(): void {
    if (!this.record('new-record')) return;
    this.playArpeggio(SFX_NEW_RECORD_NOTES, SFX_NEW_RECORD_NOTE_DURATION, 'square', sfxPeak('new-record'));
  }

  /**
   * The debug panel's COUNT: the count-up as GAME OVER plays it — ten ticks
   * GAMEOVER_COUNT_TICK_EVERY ticks apart, then the stop — recorded once.
   */
  playCountSample(): void {
    if (!this.record('count')) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const every = GAMEOVER_COUNT_TICK_EVERY / TICK_RATE;
    const now = ctx.currentTime;
    for (let i = 0; i < 10; i++) {
      this.playTone(SFX_COUNT_TICK_FREQ, SFX_COUNT_TICK_DURATION, 'triangle', sfxPeak('count-tick'), undefined, now + i * every);
    }
    this.playArpeggio(SFX_COUNT_END_NOTES, SFX_COUNT_END_NOTE_DURATION, 'triangle', sfxPeak('count-end'), now + 10 * every);
  }

  /**
   * The debug panel's DRAW: the drawing drone held for `seconds`, by itself
   * (the live drone follows the marker and would stop it at once).
   */
  playDrawSample(seconds = 1): void {
    if (!this.record('draw')) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = SFX_DRAW_FREQ_FAST;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(sfxPeak('draw'), now + 0.02);
    env.gain.setValueAtTime(sfxPeak('draw'), now + seconds);
    env.gain.linearRampToValueAtTime(0, now + seconds + 0.05);
    osc.connect(env).connect(this.masterGain);
    osc.start(now);
    osc.stop(now + seconds + 0.08);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      env.disconnect();
    });
  }

  /**
   * The names of the sounds played, oldest first, the last SFX_LOG_MAX of
   * them — only those actually played, so nothing while muted. Read by the
   * E2E suite through window.__game__.
   */
  getLog(): SfxLogName[] {
    return [...this.log];
  }

  // Notes `name` as played and says whether it may play: never while muted
  // or without audio.
  private record(name: SfxLogName): boolean {
    if (this.muted || !this.ensureContext()) return false;
    this.log.push(name);
    if (this.log.length > SFX_LOG_MAX) this.log.splice(0, this.log.length - SFX_LOG_MAX);
    return true;
  }

  private playArpeggio(
    notes: readonly number[],
    noteDuration: number,
    type: OscillatorType,
    peak: number,
    startTime?: number,
    attack = SFX_DEFAULT_ATTACK
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const start = startTime ?? ctx.currentTime;
    notes.forEach((freq, i) => {
      this.playTone(freq, noteDuration, type, peak, undefined, start + i * noteDuration, attack);
    });
  }

  /**
   * A single self-contained oscillator + gain-envelope "note": ramps up
   * quickly, decays to silence over `duration`, then disconnects itself —
   * each call creates and tears down its own nodes, so overlapping one-shot
   * SEs (e.g. an area-claimed chime while an Igniter approach beep is still
   * ringing) never fight over shared state.
   *
   * With `endFreq` the pitch glides from `freq` to it over the note, falling
   * or rising; without it the note holds `freq`. `peak` is the envelope's
   * peak, always from the level table (src/audio/sfxLevels.ts's sfxPeak());
   * `attack` is how long the note takes to reach it.
   */
  private playTone(
    freq: number,
    duration: number,
    type: OscillatorType,
    peak: number,
    endFreq?: number,
    startTime?: number,
    attack = SFX_DEFAULT_ATTACK
  ): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.resumeIfSuspended(ctx);

    const start = startTime ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, start + duration);
    }

    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(env).connect(this.masterGain);
    osc.start(start);
    osc.stop(start + duration + SFX_TONE_STOP_TAIL);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      env.disconnect();
    });
  }

  private stopDrawTone(): void {
    if (this.drawOsc && this.drawGain && this.ctx) {
      const ctx = this.ctx;
      const osc = this.drawOsc;
      const gain = this.drawGain;
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      osc.stop(ctx.currentTime + 0.08);
      osc.addEventListener('ended', () => {
        osc.disconnect();
        gain.disconnect();
      });
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
    this.masterGain.gain.value = this.muted ? 0 : sfxLevels.master;
    this.masterGain.connect(this.ctx.destination);
    return this.ctx;
  }

  /** True while the continuous line-drawing drone is currently sounding (test/inspection hook). */
  isDrawingToneActive(): boolean {
    return this.drawing;
  }
}
