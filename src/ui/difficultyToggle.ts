// The Title screen's NORMAL / EASY toggle (src/core/difficulty.ts): one
// button reading the current choice, `MODE: NORMAL` or `MODE: EASY`, flipped
// by each press. The last of the Title menu's buttons (src/ui/titleMenu.ts),
// which gives it its look, size and place. It is wide enough for the longer
// label from the start, so a press never moves it or the buttons beside it.
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
  HUD_ACCENT_COLOR,
  EASY_PROMPT_TOGGLE_PULSE_COUNT,
  EASY_PROMPT_TOGGLE_PULSE_SEC,
  EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR,
  EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX,
  EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX,
} from '../config';
import { t } from '../i18n';
import type { Difficulty } from '../core/difficulty';
import { markEnglishOnly } from './sentenceFont';

export interface DifficultyToggleOptions {
  /** The Title menu's row (src/ui/titleMenu.ts). */
  parent: HTMLElement;
  /** A press: main.ts flips the choice and calls setDifficulty(). */
  onToggle: () => void;
}

export class DifficultyToggle {
  private readonly button: HTMLButtonElement;
  private shown = false;
  // The font and padding its min-width was measured at, or null when not yet measured.
  private reservedFor: string | null = null;

  constructor(options: DifficultyToggleOptions) {
    const button = document.createElement('button');
    button.id = 'difficulty-button';
    button.type = 'button';
    button.style.display = 'none';
    // The pulse after the GAME OVER screen suggested EASY (index.html's
    // #difficulty-button[data-attention='true']).
    button.style.setProperty('--difficulty-glow', EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR);
    button.style.setProperty('--difficulty-pulse-sec', `${EASY_PROMPT_TOGGLE_PULSE_SEC}s`);
    button.style.setProperty('--difficulty-pulse-count', String(EASY_PROMPT_TOGGLE_PULSE_COUNT));
    button.style.setProperty('--difficulty-glow-rest-blur', `${EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX}px`);
    button.style.setProperty('--difficulty-glow-peak-blur', `${EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX}px`);
    button.textContent = t('difficulty.toggleNormal');
    button.addEventListener('click', (event) => {
      options.onToggle();
      (event.currentTarget as HTMLButtonElement).blur();
    });
    markEnglishOnly(button);
    options.parent.appendChild(button);
    this.button = button;
  }

  getButton(): HTMLButtonElement {
    return this.button;
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
  }

  /**
   * The lit text, its glow pulsing EASY_PROMPT_TOGGLE_PULSE_COUNT times (lit
   * and still with reduced motion): after the GAME OVER screen suggested EASY.
   */
  setAttention(on: boolean): void {
    if (this.hasAttention() === on) return;
    if (on) {
      this.button.dataset.attention = 'true';
      this.button.style.color = EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR;
    } else {
      delete this.button.dataset.attention;
      this.button.style.color = HUD_ACCENT_COLOR;
    }
  }

  hasAttention(): boolean {
    return this.button.dataset.attention === 'true';
  }

  /**
   * Sets its min-width to the longer label's width at its current font and
   * padding, keeping whichever label it shows, so a press never changes its
   * width. The Title menu calls it whenever it sizes its buttons.
   */
  reserveWidth(): void {
    const key = `${this.button.style.fontSize}|${this.button.style.padding}`;
    if (this.reservedFor === key || this.button.style.display === 'none') return;
    const label = this.button.textContent;
    this.button.style.minWidth = '';
    let widest = 0;
    for (const k of ['difficulty.toggleNormal', 'difficulty.toggleEasy'] as const) {
      this.button.textContent = t(k);
      widest = Math.max(widest, this.button.getBoundingClientRect().width);
    }
    this.button.textContent = label;
    if (widest <= 0) return;
    this.button.style.minWidth = `${widest}px`;
    this.reservedFor = key;
  }
}
