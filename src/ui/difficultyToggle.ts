// The Title screen's NORMAL / EASY toggle (src/core/difficulty.ts): one
// button reading the current choice, `MODE: NORMAL` or `MODE: EASY`, flipped
// by each press. Styled like the sound toggle (#mute-button) and sized like
// the Title screen's other buttons (HOW TO PLAY, RANKING), small on the same
// small fields. It is wide enough for the longer label from the start, so a
// press never moves it.
//
// Placed in the field's bottom-right corner (inside #canvas-wrap), clear of
// the DEMO tag (bottom-left), HOW TO PLAY and RANKING (along the top) and the
// title text (the middle). On the smallest fields the title text leaves no
// room there, so it sits just under the field instead, lined up with its
// right edge — unless the page has no room under the field either (a field
// held to its size by the height of a small window), when it goes back into
// the corner, over the title text if need be: it is always on screen and
// pressable on the Title screen.
//
// A press never starts a run, and a tap on it never reaches the field. Its
// keys go on to the page's keyboard input (src/input/keyboard.ts), which
// knows them as keys that went down on a control: neither the press nor the
// auto-repeat of a key held on — landing on the page once focus leaves the
// button after the press — counts as a press until the key is released. The
// keys must not be stopped at the button, or the keyboard input would see
// only that auto-repeat, as a fresh press.
//
// DOM-only, like the rest of src/ui/.
import {
  HUD_FONT,
  HUD_ACCENT_COLOR,
  TITLE_BUTTON_COMPACT_FONT_PX,
  TITLE_BUTTON_COMPACT_PADDING,
  TITLE_BUTTON_COMPACT_INSET_PX,
  EASY_PROMPT_TOGGLE_PULSE_COUNT,
  EASY_PROMPT_TOGGLE_PULSE_SEC,
  EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR,
  EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX,
  EASY_PROMPT_TOGGLE_GLOW_REST_SPREAD_PX,
  EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX,
  EASY_PROMPT_TOGGLE_GLOW_PEAK_SPREAD_PX,
} from '../config';
import { t } from '../i18n';
import type { Difficulty } from '../core/difficulty';
import { markEnglishOnly } from './sentenceFont';

// The roomy button's room from the field's edges (CSS px), as HOW TO PLAY's
// and RANKING's.
const INSET_PX = 8;
// Its room under the field, when it sits there (CSS px).
const BELOW_FIELD_GAP_PX = TITLE_BUTTON_COMPACT_INSET_PX;

/** Where the toggle is: in the field's bottom-right corner, or under the field. */
export type DifficultyTogglePlacement = 'corner' | 'below';

export interface DifficultyToggleOptions {
  /** #canvas-wrap: the field's own box. */
  anchor: HTMLElement;
  /** The lowest page y (CSS px) the toggle may reach when it sits under the field, unclipped and on screen. */
  getBottomLimit: () => number;
  /** A press: main.ts flips the choice and calls setDifficulty(). */
  onToggle: () => void;
}

export class DifficultyToggle {
  private readonly options: DifficultyToggleOptions;
  private readonly button: HTMLButtonElement;
  private shown = false;
  private compact = false;
  private preferBelow = false;
  private placement: DifficultyTogglePlacement = 'corner';
  // The font size its min-width was measured at, or null when not yet measured.
  private reservedFor: string | null = null;

  constructor(options: DifficultyToggleOptions) {
    this.options = options;
    const button = document.createElement('button');
    button.id = 'difficulty-button';
    button.type = 'button';
    button.style.position = 'absolute';
    button.style.boxSizing = 'border-box';
    button.style.font = HUD_FONT;
    button.style.fontSize = '1em';
    button.style.padding = '8px 16px';
    // The sound toggle's look (src/main.ts's getMuteButtonElement()).
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.whiteSpace = 'nowrap';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    button.style.zIndex = '5';
    button.style.display = 'none';
    // The pulse after the GAME OVER screen suggested EASY (index.html's
    // #difficulty-button[data-attention='true']).
    button.style.setProperty('--difficulty-glow', EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR);
    button.style.setProperty('--difficulty-pulse-sec', `${EASY_PROMPT_TOGGLE_PULSE_SEC}s`);
    button.style.setProperty('--difficulty-pulse-count', String(EASY_PROMPT_TOGGLE_PULSE_COUNT));
    button.style.setProperty('--difficulty-glow-rest-blur', `${EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX}px`);
    button.style.setProperty('--difficulty-glow-rest-spread', `${EASY_PROMPT_TOGGLE_GLOW_REST_SPREAD_PX}px`);
    button.style.setProperty('--difficulty-glow-peak-blur', `${EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX}px`);
    button.style.setProperty('--difficulty-glow-peak-spread', `${EASY_PROMPT_TOGGLE_GLOW_PEAK_SPREAD_PX}px`);
    button.textContent = t('difficulty.toggleNormal');
    button.addEventListener('click', (event) => {
      this.options.onToggle();
      (event.currentTarget as HTMLButtonElement).blur();
    });
    markEnglishOnly(button);
    options.anchor.appendChild(button);
    this.button = button;
  }

  getButton(): HTMLButtonElement {
    return this.button;
  }

  getPlacement(): DifficultyTogglePlacement {
    return this.placement;
  }

  /** The label for the current choice. */
  setDifficulty(difficulty: Difficulty): void {
    const label = t(difficulty === 'easy' ? 'difficulty.toggleEasy' : 'difficulty.toggleNormal');
    if (this.button.textContent !== label) this.button.textContent = label;
  }

  /** Shown on the live Title screen only, like HOW TO PLAY and RANKING. */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.button.style.display = shown ? 'block' : 'none';
    if (shown) this.layout();
  }

  /**
   * The small button, on a field shown less than TITLE_BUTTONS_COMPACT_BELOW_PX
   * tall, as HOW TO PLAY's and RANKING's; `belowField` on the fields too small
   * for the corner (src/main.ts's tinyField). Takes effect at the next layout().
   */
  setFieldSize(compact: boolean, belowField: boolean): void {
    if (compact !== this.compact) {
      this.compact = compact;
      this.button.style.fontSize = compact ? `${TITLE_BUTTON_COMPACT_FONT_PX}px` : '1em';
      this.button.style.padding = compact ? TITLE_BUTTON_COMPACT_PADDING : '8px 16px';
    }
    this.preferBelow = belowField;
  }

  /**
   * The lit border, pulsing EASY_PROMPT_TOGGLE_PULSE_COUNT times (lit and
   * still with reduced motion): after the GAME OVER screen suggested EASY.
   */
  setAttention(on: boolean): void {
    if (this.hasAttention() === on) return;
    if (on) {
      this.button.dataset.attention = 'true';
      this.button.style.borderColor = EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR;
    } else {
      delete this.button.dataset.attention;
      this.button.style.borderColor = HUD_ACCENT_COLOR;
    }
  }

  hasAttention(): boolean {
    return this.button.dataset.attention === 'true';
  }

  /** Places the button for the field as it is now; called whenever the field is resized and when it shows. */
  layout(): void {
    const s = this.button.style;
    const inset = this.compact ? TITLE_BUTTON_COMPACT_INSET_PX : INSET_PX;
    s.maxWidth = `calc(100% - ${inset * 2}px)`;
    if (!this.shown) return;
    this.reserveWidth();
    // Under the field when it fits there, unclipped and on screen.
    const field = this.options.anchor.getBoundingClientRect();
    const height = this.button.getBoundingClientRect().height;
    const below = this.preferBelow && field.bottom + BELOW_FIELD_GAP_PX + height <= this.options.getBottomLimit();
    this.placement = below ? 'below' : 'corner';
    s.right = below ? '0' : `${inset}px`;
    s.top = below ? `calc(100% + ${BELOW_FIELD_GAP_PX}px)` : '';
    s.bottom = below ? '' : `${inset}px`;
  }

  // Sets its min-width to the longer label's width at its current font,
  // keeping whichever label it shows, so a press never changes its width.
  private reserveWidth(): void {
    const fontSize = this.button.style.fontSize;
    if (this.reservedFor === fontSize) return;
    const label = this.button.textContent;
    this.button.style.minWidth = '';
    let widest = 0;
    for (const key of ['difficulty.toggleNormal', 'difficulty.toggleEasy'] as const) {
      this.button.textContent = t(key);
      widest = Math.max(widest, this.button.getBoundingClientRect().width);
    }
    this.button.textContent = label;
    this.button.style.minWidth = `${widest}px`;
    this.reservedFor = fontSize;
  }
}
