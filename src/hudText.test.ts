import { describe, it, expect } from 'vitest';
import {
  floorPercent,
  occupancyText,
  livesText,
  hudLines,
  HudTextInput,
  HUD_SCORE_SLOT,
  HUD_MULTIPLIER_SLOT,
  MultiplierEmphasis,
} from './hudText';

describe('occupancy and lives', () => {
  it('shows current/goal and what is left, never below 0', () => {
    expect(occupancyText(41, 75)).toBe('41%/75% 34% LEFT');
    expect(occupancyText(80, 75)).toBe('80%/75% 0% LEFT');
    expect(occupancyText(0, 65)).toBe('0%/65% 65% LEFT');
  });

  it('rounds percents down without float noise', () => {
    expect(floorPercent(0.7)).toBe(70);
    expect(floorPercent(0.29)).toBe(29);
    expect(floorPercent(0.4199)).toBe(41);
    expect(floorPercent(1.2)).toBe(100);
  });

  it('draws one mark per life slot', () => {
    expect(livesText(3, 3)).toBe('◆◆◆');
    expect(livesText(2, 3)).toBe('◆◆◇');
    expect(livesText(0, 3)).toBe('◇◇◇');
    expect(livesText(-1, 3)).toBe('◇◇◇');
    expect(livesText(7, 3)).toBe('◆x7');
  });
});

const input: HudTextInput = {
  modePrefix: '',
  stage: 3,
  hiScore: 20000,
  goal: 'TO BEST 1200',
  goalIsHiScore: false,
  time: '2:41.3',
  occupancyPercent: 41,
  goalPercent: 75,
  lives: 2,
  lifeSlots: 3,
};

function render(parts: (string | { slot: string })[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.slot === 'score' ? '12345' : 'x2')).join('');
}

describe('hudLines', () => {
  it('one line', () => {
    const { lines, timeLine } = hudLines(input, false);
    expect(lines).toHaveLength(1);
    expect(render(lines[0])).toBe('STAGE 3  SCORE 12345  TO BEST 1200  TIME 2:41.3  41%/75% 34% LEFT  ◆◆◇  x2');
    expect(lines[0]).toContain(HUD_SCORE_SLOT);
    expect(lines[0][lines[0].length - 1]).toBe(HUD_MULTIPLIER_SLOT);
    expect(timeLine).toBe(0);
  });

  it('two-line mode: STAGE/SCORE/HI, occupancy/lives/multiplier, TIME and the goal', () => {
    const { lines, timeLine } = hudLines(input, true);
    expect(lines.map(render)).toEqual(['STAGE 3  SCORE 12345  HI 20000', '41%/75% 34% LEFT  ◆◆◇  x2', 'TIME 2:41.3  TO BEST 1200']);
    expect(timeLine).toBe(2);
  });

  it('a seeded run: the prefix leads, and a goal that is the high score is not repeated in two-line mode', () => {
    const seeded = { ...input, modePrefix: 'SEED 42  ', goal: 'HI 20000', goalIsHiScore: true };
    expect(render(hudLines(seeded, false).lines[0])).toBe(
      'SEED 42  STAGE 3  SCORE 12345  HI 20000  TIME 2:41.3  41%/75% 34% LEFT  ◆◆◇  x2'
    );
    expect(hudLines(seeded, true).lines.map(render)).toEqual([
      'STAGE 3  SCORE 12345  HI 20000',
      '41%/75% 34% LEFT  ◆◆◇  x2',
      'SEED 42  TIME 2:41.3',
    ]);
  });
});

describe('MultiplierEmphasis', () => {
  const TICKS = 24;

  it('a rise shows "up" for exactly 24 ticks', () => {
    const e = new MultiplierEmphasis();
    e.step(1, false, TICKS);
    expect(e.frame()).toBeNull();
    e.step(2, false, TICKS);
    expect(e.frame()).toEqual({ kind: 'up', strength: 1 });
    for (let i = 1; i < TICKS; i++) {
      e.step(2, false, TICKS);
      expect(e.frame()?.kind).toBe('up');
    }
    e.step(2, false, TICKS);
    expect(e.frame()).toBeNull();
  });

  it('a fall back to x1 shows "down" for 24 ticks', () => {
    const e = new MultiplierEmphasis();
    e.step(3, false, TICKS);
    e.step(1, false, TICKS);
    expect(e.frame()).toEqual({ kind: 'down', strength: 1 });
    for (let i = 0; i < TICKS; i++) e.step(1, false, TICKS);
    expect(e.frame()).toBeNull();
  });

  it('a rise while the multiplier is travelling in waits for it to land', () => {
    const e = new MultiplierEmphasis();
    e.step(1, false, TICKS);
    e.step(2, true, TICKS);
    expect(e.frame()).toBeNull();
    for (let i = 0; i < 10; i++) e.step(2, true, TICKS);
    expect(e.frame()).toBeNull();
    e.step(2, false, TICKS);
    expect(e.frame()).toEqual({ kind: 'up', strength: 1 });
  });

  it('a miss during the wait cancels the pending rise', () => {
    const e = new MultiplierEmphasis();
    e.step(1, false, TICKS);
    e.step(2, true, TICKS);
    e.step(1, true, TICKS);
    expect(e.frame()?.kind).toBe('down');
    for (let i = 0; i < TICKS; i++) e.step(1, false, TICKS);
    expect(e.frame()).toBeNull();
  });

  it('reset drops the emphasis and the value to compare against', () => {
    const e = new MultiplierEmphasis();
    e.step(3, false, TICKS);
    e.step(1, false, TICKS);
    e.reset();
    expect(e.frame()).toBeNull();
    e.step(1, false, TICKS);
    expect(e.frame()).toBeNull();
  });

  it('a 0-tick duration shows nothing', () => {
    const e = new MultiplierEmphasis();
    e.step(1, false, 0);
    e.step(2, false, 0);
    expect(e.frame()).toBeNull();
  });
});
