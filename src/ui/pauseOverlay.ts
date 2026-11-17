// The pause screen: an opaque board-sized panel over the field while the live
// run is paused (src/pause.ts), with PAUSED, a RESUME button and how to
// resume. It hides the field completely — a paused run must not be studied
// with the clock stopped — while the HUD above it stays readable, showing
// the time standing still.
//
// Over everything on the field (the hint line, the effects, the GAME OVER
// modal and the ranking panels never share the screen with it) and under
// HOW TO PLAY. Showing it never moves the keyboard focus: a key pressed
// while a button has the focus is not counted by the game, and a key held
// through the pause must still count when the run resumes.
import {
  COLOR_BACKGROUND,
  COLOR_BORDER,
  HUD_ACCENT_COLOR,
  HUD_FONT,
  HUD_TEXT_COLOR,
  PAUSE_BUTTON_MIN_SIZE_PX,
  PAUSE_OVERLAY_HINT_FONT_COMPACT_PX,
  PAUSE_OVERLAY_HINT_FONT_PX,
  PAUSE_OVERLAY_TITLE_FONT_COMPACT_PX,
  PAUSE_OVERLAY_TITLE_FONT_PX,
} from '../config';
import { t } from '../i18n';
import { applySentenceFont, markEnglishOnly } from './sentenceFont';

export interface PauseOverlayOptions {
  /** Where it is mounted: #canvas-wrap, the field's own box. */
  anchor: HTMLElement;
  /** A touch device: the hint says to tap RESUME rather than press a key. */
  touch: boolean;
  /** RESUME was pressed. */
  onResume: () => void;
}

export class PauseOverlay {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly resume: HTMLButtonElement;
  private readonly hint: HTMLDivElement;
  private shown = false;
  private compact: boolean | null = null;

  constructor(options: PauseOverlayOptions) {
    const el = document.createElement('div');
    el.id = 'pause-overlay';
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.display = 'none';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.boxSizing = 'border-box';
    el.style.padding = '8px';
    el.style.overflow = 'hidden';
    el.style.background = COLOR_BACKGROUND;
    el.style.opacity = '1';
    // The field's own frame stays, so the panel reads as the field paused.
    el.style.border = `2px solid ${COLOR_BORDER}`;
    el.style.color = HUD_TEXT_COLOR;
    el.style.font = HUD_FONT;
    // #canvas-wrap's line-height is 0.
    el.style.lineHeight = '1.3';
    el.style.textAlign = 'center';
    el.style.userSelect = 'none';
    el.style.zIndex = '30';
    // A press on the panel is not a press on the field.
    el.addEventListener('pointerdown', (event) => {
      if (event.target === el) event.preventDefault();
    });

    const title = document.createElement('div');
    title.id = 'pause-title';
    title.textContent = t('pause.title');
    title.style.fontWeight = 'bold';
    title.style.letterSpacing = '0.15em';
    title.style.textShadow = `0 0 10px ${HUD_ACCENT_COLOR}, 0 0 20px ${HUD_ACCENT_COLOR}`;
    markEnglishOnly(title);
    el.appendChild(title);

    const resume = document.createElement('button');
    resume.id = 'pause-resume';
    resume.type = 'button';
    resume.textContent = t('pause.resume');
    resume.style.font = HUD_FONT;
    resume.style.fontSize = '1em';
    resume.style.color = HUD_ACCENT_COLOR;
    resume.style.background = 'rgba(10, 14, 39, 0.7)';
    resume.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    resume.style.borderRadius = '4px';
    resume.style.padding = '0 20px';
    resume.style.minWidth = `${PAUSE_BUTTON_MIN_SIZE_PX}px`;
    resume.style.minHeight = `${PAUSE_BUTTON_MIN_SIZE_PX}px`;
    resume.style.cursor = 'pointer';
    resume.style.touchAction = 'manipulation';
    resume.addEventListener('click', (event) => {
      // The focus goes back to the page, so the next keys reach the game.
      (event.currentTarget as HTMLButtonElement).blur();
      options.onResume();
    });
    markEnglishOnly(resume);
    el.appendChild(resume);

    const hint = document.createElement('div');
    hint.id = 'pause-hint';
    hint.textContent = t(options.touch ? 'pause.hint.touch' : 'pause.hint.key');
    hint.style.opacity = '0.9';
    hint.style.maxWidth = '100%';
    applySentenceFont(hint);
    el.appendChild(hint);

    options.anchor.appendChild(el);
    this.el = el;
    this.title = title;
    this.resume = resume;
    this.hint = hint;
    this.setCompact(false);
  }

  /** Shows or hides the panel; a no-op unless that changes. Hiding it takes the focus off RESUME. */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.el.style.display = shown ? 'flex' : 'none';
    if (!shown && this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  isShown(): boolean {
    return this.shown;
  }

  /** Smaller text and room on a small field, so everything stays on the panel. */
  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.el.style.gap = compact ? '6px' : '14px';
    this.title.style.fontSize = `${compact ? PAUSE_OVERLAY_TITLE_FONT_COMPACT_PX : PAUSE_OVERLAY_TITLE_FONT_PX}px`;
    this.resume.style.fontSize = compact ? '14px' : '1em';
    this.hint.style.fontSize = `${compact ? PAUSE_OVERLAY_HINT_FONT_COMPACT_PX : PAUSE_OVERLAY_HINT_FONT_PX}px`;
  }
}
