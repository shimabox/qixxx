// The three tunes' notes, against the tunes' definition written out by hand
// from the table they were chosen by (docs: TENSE / OPEN, ACID, HUNT). Each
// table row below is one row of that definition: when it plays (from the
// step's place in its bar `b`, its bar and the intensity `I`) and the notes
// it plays, as literal values — part, wave, MIDI note, length in sixteenths,
// level, filter, sharpness, detune, rise. Nothing here calls the score to make
// what it expects. Every step of the four bars (and the first bar again) is
// checked at every intensity, the notes in the table's order.
import { describe, expect, it } from 'vitest';
import { bgmNotesForStep, type BgmIntensity, type BgmNote, type BgmTrackId } from './bgmScore';

interface Want {
  part: string;
  /** MIDI note; 0 for a drum. */
  midi: number;
  steps: number;
  gain: number;
  wave?: string;
  filterHz?: number;
  q?: number;
  detune?: number;
  attack?: number;
}

type Row = (b: number, bar: number, I: number) => Want[];

const drum = (part: string, gain: number): Want => ({ part, midi: 0, steps: 1, gain });
const when = (cond: boolean, notes: Want[]): Want[] => (cond ? notes : []);

// TENSE / OPEN: roots E2 F2 E2 D2; chords Em F Em Dm.
const TENSE_ROOT = [40, 41, 40, 38];
const TENSE_CHORD = [
  [64, 67, 71],
  [65, 69, 72],
  [64, 67, 71],
  [62, 65, 69],
];
const TENSE: Row[] = [
  (b) => when(b % 4 === 0, [drum('kick', 0.9)]),
  (b, bar, I) => [
    { part: 'bass', midi: TENSE_ROOT[bar % 4] + (I >= 3 && b % 4 === 2 ? 12 : 0), steps: 0.6, gain: 0.5, wave: 'sawtooth', filterHz: 950, q: 5 },
  ],
  (b, bar, I) => [
    { part: 'bassUp', midi: TENSE_ROOT[bar % 4] + 12 + (I >= 3 && b % 4 === 2 ? 12 : 0), steps: 0.5, gain: 0.2, wave: 'sawtooth', filterHz: 1300 },
  ],
  (b, _bar, I) => when(I >= 1 && (I >= 3 || b % 4 === 2), [drum('hat', 0.35)]),
  (b, bar, I) =>
    when(
      I >= 2 && (b === 6 || b === 12),
      TENSE_CHORD[bar % 4].map((midi) => ({ part: 'stab', midi, steps: 0.5, gain: 0.14, wave: 'square', filterHz: 2400 }))
    ),
  (b, bar, I) => when(I >= 3 && b === 0, [{ part: 'riser', midi: 88 + (bar % 4), steps: 16, gain: 0.09, wave: 'sine', attack: 0.4 }]),
];

// ACID: the bass's line, semitones above E2.
const ACID_LINE = [0, 0, 12, 0, 3, 0, 12, 7, 0, 0, 10, 0, 3, 12, 0, 7];
const ACID: Row[] = [
  (b) => when(b % 4 === 0, [drum('kick', 0.9)]),
  (b, _bar, I) => [
    {
      part: 'bass',
      midi: 40 + ACID_LINE[b] + (I >= 3 && b % 8 === 6 ? 12 : 0),
      steps: 0.7,
      gain: 0.42,
      wave: 'sawtooth',
      filterHz: 380 + I * 620 + (b % 4 === 2 ? 500 : 0),
      q: 11,
    },
  ],
  (b, _bar, I) => when(I >= 1 && b % 4 === 2, [drum('hat', 0.3)]),
  (b, _bar, I) => when(I >= 2 && (b === 4 || b === 12), [drum('snare', 0.45)]),
  (b, _bar, I) => when(I >= 3 && b % 2 === 1, [drum('hat', 0.18)]),
];

// HUNT: roots D2 D2 Bb1 C2; chords Dm Dm Bb C.
const HUNT_ROOT = [38, 38, 34, 36];
const HUNT_CHORD = [
  [62, 65, 69],
  [62, 65, 69],
  [58, 62, 65],
  [60, 64, 67],
];
const HUNT: Row[] = [
  (b, _bar, I) => when(b === 0 || b === 10 || (I >= 2 && b === 7), [drum('kick', 0.95)]),
  (b) => when(b === 4 || b === 12, [drum('snare', 0.55)]),
  (b, _bar, I) => when(I >= 1 && b % 2 === 0, [drum('hat', 0.22)]),
  (b, _bar, I) => when(I >= 3 && b % 2 === 1, [drum('hat', 0.14)]),
  (b, bar, I) =>
    when(b % 8 === 0, [
      { part: 'drone', midi: HUNT_ROOT[bar % 4], steps: 7.5, gain: 0.3, wave: 'sawtooth', filterHz: 520 + I * 260, detune: -14 },
      { part: 'drone', midi: HUNT_ROOT[bar % 4], steps: 7.5, gain: 0.3, wave: 'sawtooth', filterHz: 520 + I * 260, detune: 14 },
      { part: 'drone', midi: HUNT_ROOT[bar % 4] + 12, steps: 7.5, gain: 0.1, wave: 'square', filterHz: 900 },
    ]),
  (b, bar, I) =>
    when(I >= 2 && [3, 6, 11, 14].includes(b), [
      { part: 'stab', midi: HUNT_CHORD[bar % 4][b % 3] + 12, steps: 0.6, gain: 0.12, wave: 'square', filterHz: 3000 },
    ]),
  (b, bar, I) => when(I >= 3 && b === 0, [{ part: 'riser', midi: 86 + (bar % 4), steps: 16, gain: 0.07, wave: 'sine', attack: 0.5 }]),
];

const TABLES: Record<BgmTrackId, Row[]> = { tense: TENSE, acid: ACID, hunt: HUNT };

const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

function expectNotes(notes: BgmNote[], want: Want[], label: string): void {
  expect(
    notes.map((n) => n.part),
    label
  ).toEqual(want.map((w) => w.part));
  notes.forEach((note, i) => {
    const w = want[i];
    const at = `${label} #${i} ${w.part}`;
    if (w.midi === 0) expect(note.freq, at).toBe(0);
    else expect(note.freq, at).toBeCloseTo(hz(w.midi), 9);
    expect(note.steps, at).toBe(w.steps);
    expect(note.gain, at).toBe(w.gain);
    expect(note.wave, at).toBe(w.wave);
    expect(note.filterHz, at).toBe(w.filterHz);
    expect(note.q, at).toBe(w.q);
    expect(note.detune, at).toBe(w.detune);
    expect(note.attack, at).toBe(w.attack);
  });
}

const INTENSITIES: BgmIntensity[] = [0, 1, 2, 3];

describe('the three tunes follow their definition, step by step', () => {
  for (const track of ['tense', 'acid', 'hunt'] as const) {
    for (const intensity of INTENSITIES) {
      it(`${track}, intensity ${intensity}: every step of bars 0-4`, () => {
        for (let s = 0; s < 5 * 16; s++) {
          const b = s % 16;
          const bar = Math.floor(s / 16);
          const want = TABLES[track].flatMap((row) => row(b, bar, intensity));
          expectNotes(bgmNotesForStep(track, s, intensity), want, `${track} I${intensity} step ${s}`);
        }
      });
    }
  }
});

// A few steps spelled out note by note, as a check on the tables above.
describe('the three tunes, a few steps written out', () => {
  it('tense: the first step at 0, and the third bar\'s 4th beat at 3', () => {
    expectNotes(
      bgmNotesForStep('tense', 0, 0),
      [
        drum('kick', 0.9),
        { part: 'bass', midi: 40, steps: 0.6, gain: 0.5, wave: 'sawtooth', filterHz: 950, q: 5 },
        { part: 'bassUp', midi: 52, steps: 0.5, gain: 0.2, wave: 'sawtooth', filterHz: 1300 },
      ],
      'tense 0/0'
    );
    // Bar 3 (Dm), step 12.
    expectNotes(
      bgmNotesForStep('tense', 3 * 16 + 12, 3),
      [
        drum('kick', 0.9),
        { part: 'bass', midi: 38, steps: 0.6, gain: 0.5, wave: 'sawtooth', filterHz: 950, q: 5 },
        { part: 'bassUp', midi: 50, steps: 0.5, gain: 0.2, wave: 'sawtooth', filterHz: 1300 },
        drum('hat', 0.35),
        { part: 'stab', midi: 62, steps: 0.5, gain: 0.14, wave: 'square', filterHz: 2400 },
        { part: 'stab', midi: 65, steps: 0.5, gain: 0.14, wave: 'square', filterHz: 2400 },
        { part: 'stab', midi: 69, steps: 0.5, gain: 0.14, wave: 'square', filterHz: 2400 },
      ],
      'tense 3/60'
    );
    // Bar 1 (F), step 2 at 3: the bass and its octave an octave up again.
    expectNotes(
      bgmNotesForStep('tense', 18, 3),
      [
        { part: 'bass', midi: 53, steps: 0.6, gain: 0.5, wave: 'sawtooth', filterHz: 950, q: 5 },
        { part: 'bassUp', midi: 65, steps: 0.5, gain: 0.2, wave: 'sawtooth', filterHz: 1300 },
        drum('hat', 0.35),
      ],
      'tense 3/18'
    );
  });

  it('acid: its line at 0, the open filter on the off-beats, snares from 2, the octave at 3', () => {
    const bass = (s: number, i: BgmIntensity) => bgmNotesForStep('acid', s, i).find((n) => n.part === 'bass')!;
    expect([0, 2, 4, 7, 10, 13].map((s) => Math.round(69 + 12 * Math.log2(bass(s, 0).freq / 440)))).toEqual([40, 52, 43, 47, 50, 52]);
    expect([0, 2, 6, 1].map((s) => bass(s, 0).filterHz)).toEqual([380, 880, 880, 380]);
    expect([0, 2].map((s) => bass(s, 3).filterHz)).toEqual([2240, 2740]);
    expect(Math.round(69 + 12 * Math.log2(bass(6, 3).freq / 440))).toBe(64);
    expect(Math.round(69 + 12 * Math.log2(bass(14, 3).freq / 440))).toBe(52);
    expectNotes(
      bgmNotesForStep('acid', 4, 2),
      [drum('kick', 0.9), { part: 'bass', midi: 43, steps: 0.7, gain: 0.42, wave: 'sawtooth', filterHz: 1620, q: 11 }, drum('snare', 0.45)],
      'acid 2/4'
    );
    expectNotes(
      bgmNotesForStep('acid', 7, 3),
      [{ part: 'bass', midi: 47, steps: 0.7, gain: 0.42, wave: 'sawtooth', filterHz: 2240, q: 11 }, drum('hat', 0.18)],
      'acid 3/7'
    );
  });

  it('hunt: the first step at 0 and 3, the kick on step 7 from 2, a stab from the chord', () => {
    expectNotes(
      bgmNotesForStep('hunt', 0, 0),
      [
        drum('kick', 0.95),
        { part: 'drone', midi: 38, steps: 7.5, gain: 0.3, wave: 'sawtooth', filterHz: 520, detune: -14 },
        { part: 'drone', midi: 38, steps: 7.5, gain: 0.3, wave: 'sawtooth', filterHz: 520, detune: 14 },
        { part: 'drone', midi: 50, steps: 7.5, gain: 0.1, wave: 'square', filterHz: 900 },
      ],
      'hunt 0/0'
    );
    // Bar 2 (Bb), first step, at 3.
    expectNotes(
      bgmNotesForStep('hunt', 32, 3),
      [
        drum('kick', 0.95),
        drum('hat', 0.22),
        { part: 'drone', midi: 34, steps: 7.5, gain: 0.3, wave: 'sawtooth', filterHz: 1300, detune: -14 },
        { part: 'drone', midi: 34, steps: 7.5, gain: 0.3, wave: 'sawtooth', filterHz: 1300, detune: 14 },
        { part: 'drone', midi: 46, steps: 7.5, gain: 0.1, wave: 'square', filterHz: 900 },
        { part: 'riser', midi: 88, steps: 16, gain: 0.07, wave: 'sine', attack: 0.5 },
      ],
      'hunt 3/32'
    );
    expect(bgmNotesForStep('hunt', 7, 1).map((n) => n.part)).toEqual([]);
    expect(bgmNotesForStep('hunt', 7, 2).map((n) => n.part)).toEqual(['kick']);
    // Bar 3 (C: C4 E4 G4), step 11: its 11 % 3 = 2nd tone, G4, an octave up.
    expectNotes(
      bgmNotesForStep('hunt', 48 + 11, 2),
      [{ part: 'stab', midi: 79, steps: 0.6, gain: 0.12, wave: 'square', filterHz: 3000 }],
      'hunt 2/59'
    );
  });
});
