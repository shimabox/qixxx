// The background music's scores: three tunes (TENSE / OPEN, ACID, HUNT), one
// a stage in turn (BGM_TRACK_ORDER); which notes one sixteenth-note step of
// a tune plays at an intensity; and the pace (intensity, and each tune's
// tempo) from the run's time left. Pure — no DOM, no Web Audio, no
// randomness — so the same tune, step and intensity always give the same
// notes (src/audio/bgmScore.tracks.test.ts); src/audio/bgm.ts plays them.
//
// The tunes are written as they were chosen by listening: their waves,
// notes, lengths and levels are not to be tuned here.
import { BGM_GAIN_ACID, BGM_GAIN_HUNT, BGM_GAIN_TENSE, BGM_INTENSITY_FROM_SEC, BGM_RUSH_FROM_SEC, BGM_TEMPO, BGM_TRACK_ORDER } from '../config';

export const BGM_STEPS_PER_BAR = 16;
/** Bars before a tune's chords come round again. */
export const BGM_BARS_PER_CYCLE = 4;

export type BgmTrackId = (typeof BGM_TRACK_ORDER)[number];

/** 0 (180-135s left) to 3 (30s and below): each step up never plays fewer notes. */
export type BgmIntensity = 0 | 1 | 2 | 3;

/** The drums have no pitch of their own here: src/audio/bgm.ts gives them their sound. */
export type BgmDrumPart = 'kick' | 'hat' | 'snare';
export type BgmPitchedPart = 'bass' | 'bassUp' | 'stab' | 'riser' | 'drone';
export type BgmPart = BgmPitchedPart | BgmDrumPart;

export const BGM_DRUM_PARTS: ReadonlySet<BgmPart> = new Set<BgmPart>(['kick', 'hat', 'snare']);

export type BgmWave = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface BgmNote {
  part: BgmPart;
  /** Hz; 0 for a drum. */
  freq: number;
  /** How long it sounds, in sixteenth-note steps (a drum's own length is fixed). */
  steps: number;
  /** Its level within the tune (0-1), under the tune's own gain. */
  gain: number;
  /** A pitched note's oscillator. */
  wave?: BgmWave;
  /** A low-pass filter on it (Hz). */
  filterHz?: number;
  /** That filter's sharpness (its Q), instead of the filter's own. */
  q?: number;
  /** Its pitch moved by this many cents. */
  detune?: number;
  /** Its rise (seconds), instead of the usual one. */
  attack?: number;
}

const midiToHz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);

function drum(part: BgmDrumPart, gain: number): BgmNote {
  return { part, freq: 0, steps: 1, gain };
}

function tone(part: BgmPitchedPart, wave: BgmWave, midi: number, steps: number, gain: number, more: Partial<BgmNote> = {}): BgmNote {
  return { part, freq: midiToHz(midi), steps, gain, wave, ...more };
}

const cycle = <T>(list: readonly T[], bar: number): T => list[bar % list.length];

// TENSE / OPEN — E Phrygian, Em F Em Dm, 126 -> 140 BPM.
// 0: a kick (with its click) on every beat; the bass hammering sixteenths on
//    the root (sawtooth through a sharp low-pass at 950 Hz), an octave above
//    it a quieter sawtooth (low-pass at 1300 Hz).
// 1: + the hi-hat on each beat's third sixteenth.
// 2: + chord stabs (square) on steps 6 and 12.
// 3: the hi-hat in sixteenths, both basses an octave up on each beat's third
//    sixteenth, and a high sine climbing a semitone a bar: E6 F6 F#6 G6.
const TENSE_ROOTS = [40, 41, 40, 38] as const; // E2 F2 E2 D2
const TENSE_CHORDS = [
  [64, 67, 71], // E4 G4 B4
  [65, 69, 72], // F4 A4 C5
  [64, 67, 71], // E4 G4 B4
  [62, 65, 69], // D4 F4 A4
] as const;

function tenseNotes(b: number, bar: number, I: BgmIntensity): BgmNote[] {
  const notes: BgmNote[] = [];
  const root = cycle(TENSE_ROOTS, bar);
  const up = I >= 3 && b % 4 === 2 ? 12 : 0;
  if (b % 4 === 0) notes.push(drum('kick', 0.9));
  notes.push(tone('bass', 'sawtooth', root + up, 0.6, 0.5, { filterHz: 950, q: 5 }));
  notes.push(tone('bassUp', 'sawtooth', root + 12 + up, 0.5, 0.2, { filterHz: 1300 }));
  if (I >= 1 && (I >= 3 || b % 4 === 2)) notes.push(drum('hat', 0.35));
  if (I >= 2 && (b === 6 || b === 12)) {
    for (const m of cycle(TENSE_CHORDS, bar)) notes.push(tone('stab', 'square', m, 0.5, 0.14, { filterHz: 2400 }));
  }
  if (I >= 3 && b === 0) notes.push(tone('riser', 'sine', 88 + (bar % 4), 16, 0.09, { attack: 0.4 }));
  return notes;
}

// ACID — E, one bar's line round and round, 130 -> 144 BPM.
// 0: a kick on every beat; the bass's line (sawtooth through a very sharp
//    low-pass that opens with the intensity and more on each beat's third
//    sixteenth).
// 1: + the hi-hat on each beat's third sixteenth.
// 2: + a snare on steps 4 and 12.
// 3: + a quieter hi-hat on every other sixteenth, and the line's step 6 and
//    14 an octave up.
const ACID_LINE = [0, 0, 12, 0, 3, 0, 12, 7, 0, 0, 10, 0, 3, 12, 0, 7] as const; // semitones above E2

function acidNotes(b: number, _bar: number, I: BgmIntensity): BgmNote[] {
  const notes: BgmNote[] = [];
  if (b % 4 === 0) notes.push(drum('kick', 0.9));
  const up = I >= 3 && b % 8 === 6 ? 12 : 0;
  notes.push(tone('bass', 'sawtooth', 40 + ACID_LINE[b] + up, 0.7, 0.42, { filterHz: 380 + I * 620 + (b % 4 === 2 ? 500 : 0), q: 11 }));
  if (I >= 1 && b % 4 === 2) notes.push(drum('hat', 0.3));
  if (I >= 2 && (b === 4 || b === 12)) notes.push(drum('snare', 0.45));
  if (I >= 3 && b % 2 === 1) notes.push(drum('hat', 0.18));
  return notes;
}

// HUNT — D minor, Dm Dm Bb C, 170 -> 178 BPM.
// 0: a broken kick (steps 0 and 10) and a snare on 4 and 12; a low drone
//    each half bar: two sawtooths on the root, 14 cents apart either way, and
//    a square an octave above them.
// 1: + the hi-hat on every other sixteenth.
// 2: + a kick on step 7, and short squares from the chord an octave up on
//    steps 3, 6, 11 and 14.
// 3: + a quieter hi-hat between, and a high sine climbing a semitone a bar:
//    D6 D#6 E6 F6.
const HUNT_ROOTS = [38, 38, 34, 36] as const; // D2 D2 Bb1 C2
const HUNT_CHORDS = [
  [62, 65, 69], // D4 F4 A4
  [62, 65, 69], // D4 F4 A4
  [58, 62, 65], // Bb3 D4 F4
  [60, 64, 67], // C4 E4 G4
] as const;

function huntNotes(b: number, bar: number, I: BgmIntensity): BgmNote[] {
  const notes: BgmNote[] = [];
  if (b === 0 || b === 10 || (I >= 2 && b === 7)) notes.push(drum('kick', 0.95));
  if (b === 4 || b === 12) notes.push(drum('snare', 0.55));
  if (I >= 1 && b % 2 === 0) notes.push(drum('hat', 0.22));
  if (I >= 3 && b % 2 === 1) notes.push(drum('hat', 0.14));
  if (b % 8 === 0) {
    const root = cycle(HUNT_ROOTS, bar);
    const filterHz = 520 + I * 260;
    notes.push(tone('drone', 'sawtooth', root, 7.5, 0.3, { filterHz, detune: -14 }));
    notes.push(tone('drone', 'sawtooth', root, 7.5, 0.3, { filterHz, detune: 14 }));
    notes.push(tone('drone', 'square', root + 12, 7.5, 0.1, { filterHz: 900 }));
  }
  if (I >= 2 && (b === 3 || b === 6 || b === 11 || b === 14)) {
    notes.push(tone('stab', 'square', cycle(HUNT_CHORDS, bar)[b % 3] + 12, 0.6, 0.12, { filterHz: 3000 }));
  }
  if (I >= 3 && b === 0) notes.push(tone('riser', 'sine', 86 + (bar % 4), 16, 0.07, { attack: 0.5 }));
  return notes;
}

const TUNES: Readonly<Record<BgmTrackId, (b: number, bar: number, I: BgmIntensity) => BgmNote[]>> = {
  tense: tenseNotes,
  acid: acidNotes,
  hunt: huntNotes,
};

/** Each tune's own gain under the music's level. */
const TRACK_GAINS: Readonly<Record<BgmTrackId, number>> = {
  tense: BGM_GAIN_TENSE,
  acid: BGM_GAIN_ACID,
  hunt: BGM_GAIN_HUNT,
};

/** The tune for a stage (1 and up): BGM_TRACK_ORDER in turn, round again after the last. */
export function bgmTrackForStage(stage: number): BgmTrackId {
  const n = BGM_TRACK_ORDER.length;
  const i = Math.max(0, Math.floor(stage) - 1);
  return BGM_TRACK_ORDER[i % n];
}

/** The notes of `track` that start on sixteenth-note `step` (0 = the first bar's first step). */
export function bgmNotesForStep(track: BgmTrackId, step: number, intensity: BgmIntensity): BgmNote[] {
  const s = Math.max(0, Math.floor(step));
  return TUNES[track](s % BGM_STEPS_PER_BAR, Math.floor(s / BGM_STEPS_PER_BAR), intensity);
}

/** A tune's own gain. */
export function bgmTrackGain(track: BgmTrackId): number {
  return TRACK_GAINS[track];
}

/** The intensity for this much of the run's time left (seconds). */
export function bgmIntensityFor(remainingSec: number): BgmIntensity {
  let intensity = 0;
  for (const from of BGM_INTENSITY_FROM_SEC) if (remainingSec <= from) intensity++;
  return Math.min(3, intensity) as BgmIntensity;
}

/** A tune's tempo for this much of the run's time left (seconds). */
export function bgmBpmFor(track: BgmTrackId, remainingSec: number): number {
  const tempo = BGM_TEMPO[track];
  return remainingSec <= BGM_RUSH_FROM_SEC ? tempo.rushBpm : tempo.bpm;
}

/** One sixteenth-note step at `bpm`, in seconds. */
export function bgmStepSeconds(bpm: number): number {
  return 60 / bpm / 4;
}
