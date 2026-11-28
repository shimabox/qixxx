import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SFX_TIERS,
  SFX_VOICE_LEVELS,
  createDefaultSfxLevels,
  resetSfxLevels,
  sfxLevels,
  sfxPeak,
  type SfxVoice,
} from './sfxLevels';
import { SFX_MASTER_GAIN } from '../config';

afterEach(() => resetSfxLevels());

describe('the sound level table', () => {
  it('starts the tiers loudest first: split > impact > warning > enemy > draw', () => {
    const levels = createDefaultSfxLevels();
    expect(SFX_TIERS).toEqual(['split', 'impact', 'warning', 'enemy', 'draw']);
    for (let i = 1; i < SFX_TIERS.length; i++) {
      expect(levels[SFX_TIERS[i - 1]]).toBeGreaterThan(levels[SFX_TIERS[i]]);
    }
    expect(levels.draw).toBeGreaterThan(0);
    expect(levels.master).toBe(SFX_MASTER_GAIN);
  });

  it('plays every voice at its tier level times a share above 0 and at most 1', () => {
    for (const [voice, { tier, share }] of Object.entries(SFX_VOICE_LEVELS)) {
      expect(share, voice).toBeGreaterThan(0);
      expect(share, voice).toBeLessThanOrEqual(1);
      expect(sfxPeak(voice as SfxVoice), voice).toBeCloseTo(sfxLevels[tier] * share, 12);
    }
  });

  it('the loudest voice of each tier plays at the tier level itself', () => {
    for (const tier of SFX_TIERS) {
      const shares = Object.values(SFX_VOICE_LEVELS)
        .filter((v) => v.tier === tier)
        .map((v) => v.share);
      expect(Math.max(...shares), tier).toBe(1);
    }
  });

  it('follows a changed tier level, and RESET puts it back', () => {
    const before = sfxPeak('miss');
    sfxLevels.impact = 0.1;
    expect(sfxPeak('miss')).toBeCloseTo(0.08, 12);
    expect(sfxPeak('claim-hit')).toBeCloseTo(0.086, 12);
    resetSfxLevels();
    expect(sfxPeak('miss')).toBe(before);
  });
});

// Splits a call's argument list at its top-level commas.
function topLevelArgs(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  throw new Error('unbalanced call');
}

describe('src/audio/sfx.ts', () => {
  const source = readFileSync(fileURLToPath(new URL('./sfx.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('writes no loudness as a number: every playTone() / playArpeggio() gain comes from the table', () => {
    const calls = [...source.matchAll(/this\.(playTone|playArpeggio)\(/g)];
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) {
      const args = topLevelArgs(source, call.index! + call[0].length - 1);
      const gain = args[3];
      expect(gain, `${call[1]}(${args.join(', ')})`).toMatch(/peak|level/i);
      expect(gain).not.toMatch(/^[\d.]+$/);
    }
  });

  it('gives playTone() no default loudness', () => {
    const signature = source.match(/private playTone\(([\s\S]*?)\): void/);
    expect(signature).not.toBeNull();
    expect(signature![1]).not.toMatch(/(gain|peak)\s*(:\s*number\s*)?=\s*[\d.]/);
  });
});
