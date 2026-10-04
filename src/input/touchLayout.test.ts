import { describe, expect, it } from 'vitest';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  TOUCH_LAYOUT_HUD_RESERVE_HEIGHT,
  TOUCH_NARROW_SIDE_HUD_LINE_EM,
} from '../config';
import { estimateFieldWidth, resolveNarrowSideHudFontSize, resolveTouchLayout } from './touch';

// Mirrors touch.ts's side column width and bottom control row height.
const SIDE_COLUMN_WIDTH = 232;
const BOTTOM_CONTROLS_HEIGHT = 220;

describe('resolveTouchLayout', () => {
  it.each([
    // Narrow touch landscapes take the layout with the larger field.
    [{ touchCapable: true, viewportWidth: 667, viewportHeight: 375 }, 'side'],
    [{ touchCapable: true, viewportWidth: 667, viewportHeight: 335 }, 'side'],
    [{ touchCapable: true, viewportWidth: 667, viewportHeight: 320 }, 'side'],
    [{ touchCapable: true, viewportWidth: 703, viewportHeight: 300 }, 'side'],
    [{ touchCapable: true, viewportWidth: 640, viewportHeight: 480 }, 'bottom'],
    [{ touchCapable: true, viewportWidth: 400, viewportHeight: 399 }, 'bottom'],
    // Wide touch landscapes always use side mode.
    [{ touchCapable: true, viewportWidth: 704, viewportHeight: 300 }, 'side'],
    [{ touchCapable: true, viewportWidth: 812, viewportHeight: 375 }, 'side'],
    [{ touchCapable: true, viewportWidth: 802, viewportHeight: 293 }, 'side'],
    [{ touchCapable: true, viewportWidth: 1024, viewportHeight: 768 }, 'side'],
    // Portrait, square, and non-touch viewports use bottom mode.
    [{ touchCapable: true, viewportWidth: 375, viewportHeight: 667 }, 'bottom'],
    [{ touchCapable: true, viewportWidth: 672, viewportHeight: 672 }, 'bottom'],
    [{ touchCapable: false, viewportWidth: 1280, viewportHeight: 720 }, 'bottom'],
    [{ touchCapable: false, viewportWidth: 667, viewportHeight: 375 }, 'bottom'],
  ] as const)('resolves %o as %s', (input, expected) => {
    expect(resolveTouchLayout(input)).toBe(expected);
  });
});

describe('estimateFieldWidth', () => {
  it('returns 0 when the field has no room', () => {
    // Center column of 400 - 2 * 232 < 0.
    expect(estimateFieldWidth('side', 400, 399)).toBe(0);
    // Height left for the field: 280 - HUD reserve - 220 < 0.
    expect(estimateFieldWidth('bottom', 640, 280)).toBe(0);
  });

  it('is limited by the available width', () => {
    // Side 667x375: the 203px center column is the binding constraint.
    expect(estimateFieldWidth('side', 667, 375)).toBeCloseTo(667 - 2 * SIDE_COLUMN_WIDTH);
  });

  it('is limited by the available height', () => {
    const availH = 375 - TOUCH_LAYOUT_HUD_RESERVE_HEIGHT - BOTTOM_CONTROLS_HEIGHT;
    expect(estimateFieldWidth('bottom', 667, 375)).toBeCloseTo(
      (CANVAS_WIDTH * availH) / CANVAS_HEIGHT,
    );
    const sideAvailH = 300 - TOUCH_LAYOUT_HUD_RESERVE_HEIGHT;
    expect(estimateFieldWidth('side', 1024, 300)).toBeCloseTo(
      (CANVAS_WIDTH * sideAvailH) / CANVAS_HEIGHT,
    );
  });
});

describe('resolveNarrowSideHudFontSize', () => {
  it('scales with the center column of a narrow side layout', () => {
    expect(resolveNarrowSideHudFontSize('side', 667)).toBeCloseTo(
      (667 - 2 * SIDE_COLUMN_WIDTH) / TOUCH_NARROW_SIDE_HUD_LINE_EM,
    );
  });

  it('never goes below 10px', () => {
    expect(resolveNarrowSideHudFontSize('side', 568)).toBe(10);
  });

  it('keeps the default HUD size for wide side layouts and bottom mode', () => {
    expect(resolveNarrowSideHudFontSize('side', 704)).toBeNull();
    expect(resolveNarrowSideHudFontSize('side', 812)).toBeNull();
    expect(resolveNarrowSideHudFontSize('bottom', 667)).toBeNull();
  });
});
