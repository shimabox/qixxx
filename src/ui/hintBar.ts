// The in-play hint's line (#hint-bar) over the field, and the glow on the
// touch button it is about. The hint itself is chosen by src/hints/; this
// only shows it. Never takes a tap (pointer-events: none) and never changes
// another element's text, so it stays out of the game's way.
import type { HintView } from '../hints/director';
import { t } from '../i18n';
import { applySentenceFont } from './sentenceFont';
import {
  GRID_HEIGHT,
  HINT_BAR_COMPACT_BELOW_PX,
  HINT_BAR_FONT_COMPACT_PX,
  HINT_BAR_FONT_MAX_PX,
  HINT_BAR_FONT_PER_FIELD_WIDTH,
  HINT_BAR_FONT_PX,
  HINT_FADE_TICKS,
} from '../config';

/** The line's text size (CSS px) on a field shown `width` x `height` (see HINT_BAR_FONT_PX in src/config.ts). */
export function hintBarFontPx(width: number, height: number): number {
  if (height < HINT_BAR_COMPACT_BELOW_PX) return HINT_BAR_FONT_COMPACT_PX;
  const scaled = Math.round(width * HINT_BAR_FONT_PER_FIELD_WIDTH);
  return Math.min(HINT_BAR_FONT_MAX_PX, Math.max(HINT_BAR_FONT_PX, scaled));
}

/** The marker in the field's lower part (this share of its height) moves the line to the top. */
const LOWER_PART_SHARE = 0.35;
const GLOW_PERIOD_TICKS = 40;
const GLOW_COLOR = '255, 255, 255';

/** The line's opacity: fading in over its first HINT_FADE_TICKS, a timed hint out over its last. 1 with reduced motion. */
export function hintBarOpacity(view: Pick<HintView<unknown>, 'age' | 'remaining'>, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  const fadeIn = Math.min(1, (view.age + 1) / HINT_FADE_TICKS);
  const fadeOut = view.remaining === null ? 1 : Math.min(1, view.remaining / HINT_FADE_TICKS);
  return Math.round(Math.min(fadeIn, fadeOut) * 1000) / 1000;
}

/** Whether the line goes to the field's top edge: the marker (row `markerY`) is in the lower part. */
export function hintBarAtTop(markerY: number): boolean {
  return markerY >= GRID_HEIGHT * (1 - LOWER_PART_SHARE);
}

/** The touch button glow's box-shadow for a hint `age` ticks old. Held still with reduced motion. */
export function hintGlowShadow(age: number, reducedMotion: boolean): string {
  const pulse = reducedMotion ? 1 : 0.5 + 0.5 * Math.cos((age * 2 * Math.PI) / GLOW_PERIOD_TICKS);
  const spread = Math.round((3 + 3 * pulse) * 10) / 10;
  const alpha = Math.round((0.55 + 0.4 * pulse) * 100) / 100;
  return `0 0 0 2px rgba(${GLOW_COLOR}, ${alpha}), 0 0 ${Math.round(spread * 3)}px ${spread}px rgba(${GLOW_COLOR}, ${alpha})`;
}

export interface HintBarFrame {
  view: HintView<unknown> | null;
  /** The marker's row, for the line's top/bottom placement. */
  markerY: number;
  /** The field's on-screen width and height (CSS px), for the text size. */
  fieldCssWidth: number;
  fieldCssHeight: number;
  reducedMotion: boolean;
}

export class HintBar {
  private readonly el: HTMLDivElement;
  private lastKey = '';
  private lastText = '';
  private glowing: HTMLElement | null = null;
  private lastGlow = '';

  constructor(wrap: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'hint-bar';
    el.style.position = 'absolute';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.width = 'max-content';
    el.style.maxWidth = '92%';
    el.style.boxSizing = 'border-box';
    el.style.padding = '3px 8px';
    el.style.borderRadius = '4px';
    el.style.background = 'rgba(5, 8, 24, 0.82)';
    el.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    el.style.color = '#ffffff';
    el.style.font = `${HINT_BAR_FONT_PX}px monospace`;
    // Explicit: #canvas-wrap's line-height is 0.
    el.style.lineHeight = '1.3';
    el.style.textAlign = 'center';
    el.style.whiteSpace = 'normal';
    el.style.overflowWrap = 'anywhere';
    el.style.pointerEvents = 'none';
    el.style.userSelect = 'none';
    el.style.zIndex = '4';
    el.style.display = 'none';
    applySentenceFont(el);
    wrap.appendChild(el);
    this.el = el;
  }

  getElement(): HTMLDivElement {
    return this.el;
  }

  /** Shows `frame.view` (or nothing); cheap when nothing changed. */
  render(frame: HintBarFrame, touchButton: (glow: 'fast' | 'slow') => HTMLElement | null): void {
    const view = frame.view;
    if (view === null) {
      this.hide();
      return;
    }
    const text = t(view.textKey);
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
    }
    const top = hintBarAtTop(frame.markerY);
    const fontPx = hintBarFontPx(frame.fieldCssWidth, frame.fieldCssHeight);
    const opacity = hintBarOpacity(view, frame.reducedMotion);
    const key = `${top}|${fontPx}|${opacity}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.el.style.display = 'block';
      this.el.style.top = top ? '6%' : '';
      this.el.style.bottom = top ? '' : '6%';
      this.el.style.fontSize = `${fontPx}px`;
      // A small field (a phone held sideways) packs the lines tighter, so a
      // sentence that wraps to three lines still covers under a third of it.
      const compact = fontPx < HINT_BAR_FONT_PX;
      this.el.style.padding = compact ? '1px 5px' : '3px 8px';
      this.el.style.lineHeight = compact ? '1.15' : '1.3';
      this.el.style.opacity = String(opacity);
      this.el.dataset.position = top ? 'top' : 'bottom';
    }
    this.setGlow(view.glow ? touchButton(view.glow) : null, view.age, frame.reducedMotion);
  }

  hide(): void {
    if (this.lastText !== '' || this.el.style.display !== 'none') {
      this.lastText = '';
      this.lastKey = '';
      this.el.textContent = '';
      this.el.style.display = 'none';
    }
    this.setGlow(null, 0, true);
  }

  private setGlow(button: HTMLElement | null, age: number, reducedMotion: boolean): void {
    if (button !== this.glowing) {
      if (this.glowing) {
        this.glowing.style.boxShadow = '';
        delete this.glowing.dataset.hintGlow;
      }
      this.glowing = button;
      this.lastGlow = '';
    }
    if (!button) return;
    const shadow = hintGlowShadow(age, reducedMotion);
    if (shadow === this.lastGlow) return;
    this.lastGlow = shadow;
    button.style.boxShadow = shadow;
    button.dataset.hintGlow = '';
  }
}
