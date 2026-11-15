// The effects' text never shrinks below FX_TEXT_MIN_DISPLAY_PX on screen.
import { describe, it, expect } from 'vitest';
import { popupFontSizes } from './fxLayer';
import { FX_TEXT_MIN_DISPLAY_PX } from '../config';

/** What main.ts hands the renderer for a field shown at `displayScale`. */
const minFontPx = (displayScale: number) => FX_TEXT_MIN_DISPLAY_PX / displayScale;

describe('popupFontSizes', () => {
  it('at display scale 0.6 every text is at least 11 / 0.6 canvas px', () => {
    const floor = 11 / 0.6;
    for (const scale of [1, 1.4]) {
      const sizes = popupFontSizes(scale, minFontPx(0.6));
      expect(sizes.scorePx).toBeGreaterThanOrEqual(floor);
      expect(sizes.notePx).toBeGreaterThanOrEqual(floor);
      expect(sizes.praisePx).toBeGreaterThanOrEqual(floor);
      expect(sizes.chainPx).toBeGreaterThanOrEqual(floor);
    }
    // CHAIN xN (13.2 canvas px) is the one actually raised.
    expect(popupFontSizes(1, minFontPx(0.6)).chainPx).toBeCloseTo(floor);
  });

  it('at display scale 1 and above the sizes are what they were', () => {
    const before = popupFontSizes(1);
    expect(before).toEqual({ scorePx: 22, notePx: 14, praisePx: 22 * 1.3, chainPx: 22 * 0.6 });
    for (const displayScale of [1, 1.5, 2.5]) {
      expect(popupFontSizes(1, minFontPx(displayScale))).toEqual(before);
      expect(popupFontSizes(1.4, minFontPx(displayScale))).toEqual(popupFontSizes(1.4));
    }
  });
});
