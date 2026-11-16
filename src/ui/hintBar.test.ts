import { describe, expect, it } from 'vitest';
import { hintBarAtTop, hintBarFontPx, hintBarOpacity, hintGlowShadow } from './hintBar';
import { GRID_HEIGHT, HINT_FADE_TICKS } from '../config';

describe('hintBarFontPx', () => {
  it('follows the field width between 13px and 18px, and is 12px on a field under 200px tall', () => {
    // A PC screen's field (1280x800): the cap.
    expect(hintBarFontPx(1021, 766)).toBe(18);
    expect(hintBarFontPx(833, 625)).toBe(15);
    // Phones: the floor, as before.
    expect(hintBarFontPx(390, 292)).toBe(13);
    expect(hintBarFontPx(380, 285)).toBe(13);
    // A phone held sideways with the touch controls on both sides.
    expect(hintBarFontPx(203, 152)).toBe(12);
    expect(hintBarFontPx(2000, 199)).toBe(12);
  });
});

describe('hintBarOpacity', () => {
  it('fades in over HINT_FADE_TICKS and a timed hint out over its last ones', () => {
    expect(hintBarOpacity({ age: 0, remaining: null }, false)).toBeLessThan(1);
    expect(hintBarOpacity({ age: HINT_FADE_TICKS - 1, remaining: null }, false)).toBe(1);
    expect(hintBarOpacity({ age: 500, remaining: null }, false)).toBe(1);
    expect(hintBarOpacity({ age: 100, remaining: 50 }, false)).toBe(1);
    expect(hintBarOpacity({ age: 140, remaining: 1 }, false)).toBeLessThan(0.2);
  });

  it('stays at 1 with reduced motion', () => {
    for (const view of [
      { age: 0, remaining: null },
      { age: 3, remaining: 147 },
      { age: 149, remaining: 1 },
    ]) {
      expect(hintBarOpacity(view, true)).toBe(1);
    }
  });
});

describe('hintBarAtTop', () => {
  it('moves the line to the top while the marker is in the lower 35% of the field', () => {
    expect(hintBarAtTop(0)).toBe(false);
    expect(hintBarAtTop(Math.floor(GRID_HEIGHT * 0.65) - 1)).toBe(false);
    expect(hintBarAtTop(Math.ceil(GRID_HEIGHT * 0.65))).toBe(true);
    expect(hintBarAtTop(GRID_HEIGHT - 1)).toBe(true);
  });
});

describe('hintGlowShadow', () => {
  it('pulses with the age, and holds still with reduced motion', () => {
    const moving = new Set([0, 10, 20, 30].map((age) => hintGlowShadow(age, false)));
    expect(moving.size).toBeGreaterThan(1);
    const still = new Set([0, 10, 20, 30, 77].map((age) => hintGlowShadow(age, true)));
    expect(still.size).toBe(1);
    expect([...still][0]).not.toBe('');
  });
});
