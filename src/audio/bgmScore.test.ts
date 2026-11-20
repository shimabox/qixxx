import { describe, expect, it } from 'vitest';
import { BGM_GAIN_ACID, BGM_GAIN_HUNT, BGM_GAIN_TENSE, BGM_TRACK_ORDER } from '../config';
import {
  BGM_DRUM_PARTS,
  BGM_STEPS_PER_BAR,
  bgmBpmFor,
  bgmIntensityFor,
  bgmNotesForStep,
  bgmStepSeconds,
  bgmTrackForStage,
  bgmTrackGain,
  type BgmIntensity,
  type BgmNote,
  type BgmPart,
  type BgmTrackId,
} from './bgmScore';

const TRACKS: BgmTrackId[] = ['tense', 'acid', 'hunt'];
const INTENSITIES: BgmIntensity[] = [0, 1, 2, 3];
const CYCLE = 4 * BGM_STEPS_PER_BAR;

const notesOver = (track: BgmTrackId, intensity: BgmIntensity, steps = CYCLE, from = 0): BgmNote[][] =>
  Array.from({ length: steps }, (_, i) => bgmNotesForStep(track, from + i, intensity));

const partsOver = (track: BgmTrackId, intensity: BgmIntensity): Set<BgmPart> =>
  new Set(notesOver(track, intensity).flat().map((n) => n.part));

describe('the BGM tunes', () => {
  it('give the same notes for the same arguments, and come round every four bars', () => {
    for (const track of TRACKS) {
      for (const intensity of INTENSITIES) {
        for (let step = 0; step < 200; step += 3) {
          expect(bgmNotesForStep(track, step, intensity)).toEqual(bgmNotesForStep(track, step, intensity));
          expect(bgmNotesForStep(track, step + CYCLE, intensity)).toEqual(bgmNotesForStep(track, step, intensity));
        }
      }
    }
  });

  it('keep every pitched note between 40 Hz and 4000 Hz, each with a length, a level and a wave', () => {
    for (const track of TRACKS) {
      for (const intensity of INTENSITIES) {
        for (const note of notesOver(track, intensity).flat()) {
          expect(note.steps).toBeGreaterThan(0);
          expect(note.gain).toBeGreaterThan(0);
          expect(note.gain).toBeLessThanOrEqual(1);
          if (BGM_DRUM_PARTS.has(note.part)) continue;
          // HUNT's lowest drone is Bb1 (58.3 Hz).
          expect(note.freq).toBeGreaterThanOrEqual(40);
          expect(note.freq).toBeLessThanOrEqual(4000);
          expect(note.wave).toBeDefined();
        }
      }
    }
  });

  it('never play fewer notes over four bars as the intensity rises, and more at 3 than at 0', () => {
    for (const track of TRACKS) {
      const counts = INTENSITIES.map((i) => notesOver(track, i).flat().length);
      for (let i = 1; i < counts.length; i++) expect(counts[i], `${track} intensity ${i}`).toBeGreaterThanOrEqual(counts[i - 1]);
      expect(counts[3], track).toBeGreaterThan(counts[0]);
    }
  });

  it('the parts by intensity', () => {
    expect(INTENSITIES.map((i) => [...partsOver('tense', i)].sort())).toEqual([
      ['bass', 'bassUp', 'kick'],
      ['bass', 'bassUp', 'hat', 'kick'],
      ['bass', 'bassUp', 'hat', 'kick', 'stab'],
      ['bass', 'bassUp', 'hat', 'kick', 'riser', 'stab'],
    ]);
    expect(INTENSITIES.map((i) => [...partsOver('acid', i)].sort())).toEqual([
      ['bass', 'kick'],
      ['bass', 'hat', 'kick'],
      ['bass', 'hat', 'kick', 'snare'],
      ['bass', 'hat', 'kick', 'snare'],
    ]);
    expect(INTENSITIES.map((i) => [...partsOver('hunt', i)].sort())).toEqual([
      ['drone', 'kick', 'snare'],
      ['drone', 'hat', 'kick', 'snare'],
      ['drone', 'hat', 'kick', 'snare', 'stab'],
      ['drone', 'hat', 'kick', 'riser', 'snare', 'stab'],
    ]);
  });

  // Small speakers play little below 300 Hz: a note counts as heard when it
  // is (a) 400 Hz or higher, (b) a square or sawtooth with no filter or one
  // at 800 Hz and up, or (c) a kick (with its click), a snare or a hi-hat.
  const heard = (n: BgmNote): boolean =>
    BGM_DRUM_PARTS.has(n.part) ||
    n.freq >= 400 ||
    ((n.wave === 'square' || n.wave === 'sawtooth') && (n.filterHz === undefined || n.filterHz >= 800));

  it('in every tune, at every intensity, every bar of the four has at least 4 notes small speakers play', () => {
    for (const track of TRACKS) {
      for (const intensity of INTENSITIES) {
        for (let bar = 0; bar < 4; bar++) {
          const notes = notesOver(track, intensity, BGM_STEPS_PER_BAR, bar * BGM_STEPS_PER_BAR).flat();
          expect(notes.filter(heard).length, `${track} intensity ${intensity} bar ${bar}`).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });

  it("each tune's own gain: TENSE 0.2, ACID 0.18, HUNT 0.18", () => {
    expect([BGM_GAIN_TENSE, BGM_GAIN_ACID, BGM_GAIN_HUNT]).toEqual([0.2, 0.18, 0.18]);
    expect(TRACKS.map(bgmTrackGain)).toEqual([0.2, 0.18, 0.18]);
  });
});

describe('the tune for a stage', () => {
  it('tense, acid, hunt in turn, and round again', () => {
    expect(BGM_TRACK_ORDER).toEqual(['tense', 'acid', 'hunt']);
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(bgmTrackForStage)).toEqual(['tense', 'acid', 'hunt', 'tense', 'acid', 'hunt', 'tense', 'tense']);
  });
});

describe('the BGM pace from the time left', () => {
  it('intensity 0 from 180s to 135s, 1 to 90s, 2 to 30s, 3 at 30s and below', () => {
    expect(bgmIntensityFor(180)).toBe(0);
    expect(bgmIntensityFor(135.01)).toBe(0);
    expect(bgmIntensityFor(135)).toBe(1);
    expect(bgmIntensityFor(90.5)).toBe(1);
    expect(bgmIntensityFor(90)).toBe(2);
    expect(bgmIntensityFor(30.01)).toBe(2);
    expect(bgmIntensityFor(30)).toBe(3);
    expect(bgmIntensityFor(0)).toBe(3);
  });

  it('each tune its own tempo, the faster from 30s left: tense 126 / 140, acid 130 / 144, hunt 170 / 178', () => {
    const tempos = (track: BgmTrackId) => [180, 30.01, 30, 1].map((left) => bgmBpmFor(track, left));
    expect(tempos('tense')).toEqual([126, 126, 140, 140]);
    expect(tempos('acid')).toEqual([130, 130, 144, 144]);
    expect(tempos('hunt')).toEqual([170, 170, 178, 178]);
    expect(bgmStepSeconds(120)).toBeCloseTo(0.125, 12);
  });
});
