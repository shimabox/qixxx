// How loud every sound effect is, in one table. Each sound belongs to a tier
// (the most important moments in the loudest one) and plays at a share of
// that tier's level: its envelope's peak is `level of its tier × share`. The
// tier levels and the overall master start from src/config.ts and live in
// `sfxLevels`, which SfxEngine reads on every sound — the debug panel's SOUND
// section changes them in place, so a change applies from the next sound
// (the master at once, on the master gain). Nothing here touches the run.
import {
  SFX_MASTER_GAIN,
  SFX_LEVEL_SPLIT,
  SFX_LEVEL_IMPACT,
  SFX_LEVEL_WARNING,
  SFX_LEVEL_ENEMY,
  SFX_LEVEL_DRAW,
} from '../config';

/** The tiers, loudest first. */
export type SfxTier = 'split' | 'impact' | 'warning' | 'enemy' | 'draw';

export const SFX_TIERS: readonly SfxTier[] = ['split', 'impact', 'warning', 'enemy', 'draw'];

export interface SfxLevels extends Record<SfxTier, number> {
  /** The master gain every sound goes through. */
  master: number;
}

/** A fresh copy of the config.ts starting values. */
export function createDefaultSfxLevels(): SfxLevels {
  return {
    master: SFX_MASTER_GAIN,
    split: SFX_LEVEL_SPLIT,
    impact: SFX_LEVEL_IMPACT,
    warning: SFX_LEVEL_WARNING,
    enemy: SFX_LEVEL_ENEMY,
    draw: SFX_LEVEL_DRAW,
  };
}

/** The live, mutable levels SfxEngine reads. */
export const sfxLevels: SfxLevels = createDefaultSfxLevels();

/** Puts every level back to its config.ts starting value (the debug panel's RESET). */
export function resetSfxLevels(): void {
  Object.assign(sfxLevels, createDefaultSfxLevels());
}

/** Every sound (or layer of one) with its own level. */
export type SfxVoice =
  | 'split-impact'
  | 'split-clear'
  | 'claim-hit'
  | 'claim-low'
  | 'claim-rise'
  | 'miss'
  | 'miss-overtone'
  | 'stage-clear'
  | 'gameover'
  | 'new-record'
  | 'count-end'
  | 'time-alarm'
  | 'time-beep'
  | 'ember-entered-line'
  | 'wisp-surge'
  | 'igniter-spawn'
  | 'blaze-spawn'
  | 'ember-spawn'
  | 'ember-despawn'
  | 'igniter-approach'
  | 'count-tick'
  | 'draw';

export interface SfxVoiceLevel {
  tier: SfxTier;
  /** The share of the tier's level, above 0 and at most 1. */
  share: number;
}

export const SFX_VOICE_LEVELS: Readonly<Record<SfxVoice, SfxVoiceLevel>> = {
  // 1. The split: the biggest moment of a run.
  'split-impact': { tier: 'split', share: 1 },
  'split-clear': { tier: 'split', share: 0.72 },
  // 2. Claims, the miss, the clears and the GAME OVER close.
  'claim-hit': { tier: 'impact', share: 0.86 },
  'claim-low': { tier: 'impact', share: 0.8 },
  'claim-rise': { tier: 'impact', share: 0.5 },
  // The miss and its octave-up layer sound together: their peaks add up to
  // 0.8 + 0.4 = 1.2 of the tier (0.336), still under the split's impact.
  miss: { tier: 'impact', share: 0.8 },
  // The miss's octave-up layer, there for small speakers that drop its 90 Hz:
  // well under the miss itself, so the low fall stays what is heard on
  // larger ones.
  'miss-overtone': { tier: 'impact', share: 0.4 },
  'stage-clear': { tier: 'impact', share: 0.86 },
  gameover: { tier: 'impact', share: 0.9 },
  'new-record': { tier: 'impact', share: 1 },
  'count-end': { tier: 'impact', share: 0.7 },
  // 3. Warnings.
  'time-alarm': { tier: 'warning', share: 1 },
  'time-beep': { tier: 'warning', share: 0.9 },
  'ember-entered-line': { tier: 'warning', share: 0.8 },
  // The Wisps speeding up as the goal nears.
  'wisp-surge': { tier: 'warning', share: 0.8 },
  // 4. Enemies appearing, and the count-up's tick.
  'igniter-spawn': { tier: 'enemy', share: 1 },
  'blaze-spawn': { tier: 'enemy', share: 1 },
  'ember-spawn': { tier: 'enemy', share: 0.85 },
  'ember-despawn': { tier: 'enemy', share: 0.85 },
  'igniter-approach': { tier: 'enemy', share: 0.7 },
  'count-tick': { tier: 'enemy', share: 0.5 },
  // 5. The drone while drawing.
  draw: { tier: 'draw', share: 1 },
};

/** The envelope peak `voice` plays at with these levels. */
export function sfxPeak(voice: SfxVoice, levels: SfxLevels = sfxLevels): number {
  const { tier, share } = SFX_VOICE_LEVELS[voice];
  return levels[tier] * share;
}
