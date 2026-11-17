// The Title screen's sound toggle: SOUND: OFF / SOUND: ON on the field,
// below the title text, so the game's sound is noticed before a run starts.
// It does exactly what the MUTE / UNMUTE button in the corner does (the same
// toggle, saved the same way); both show the same state.
//
// Pressing it never starts a run: a click or a tap lands on the button, not
// the field, and a key pressed while it has the focus is not counted by the
// game. It gives the focus back right after, so the next Enter starts a run.
import { HUD_ACCENT_COLOR, HUD_FONT, TITLE_SOUND_BUTTON_BOTTOM_RATIO } from '../config';
import { t } from '../i18n';
import { markEnglishOnly } from './sentenceFont';

export interface TitleSoundButtonOptions {
  /** Where it is mounted: #canvas-wrap, the field's own box. */
  anchor: HTMLElement;
  onToggle: () => void;
}

export class TitleSoundButton {
  private readonly button: HTMLButtonElement;
  private shown: boolean | null = null;
  private muted: boolean | null = null;

  constructor(options: TitleSoundButtonOptions) {
    const button = document.createElement('button');
    button.id = 'title-sound-button';
    button.type = 'button';
    // Built like the RANKING button (src/ui/ranking.ts's mountTitleButton()),
    // centered across the field, TITLE_SOUND_BUTTON_BOTTOM_RATIO of the
    // field's height above its bottom edge.
    button.style.position = 'absolute';
    button.style.left = '50%';
    button.style.bottom = `${TITLE_SOUND_BUTTON_BOTTOM_RATIO * 100}%`;
    button.style.transform = 'translateX(-50%)';
    button.style.font = HUD_FONT;
    button.style.fontSize = '1em';
    button.style.lineHeight = 'normal';
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.padding = '8px 16px';
    button.style.whiteSpace = 'nowrap';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    button.style.zIndex = '5';
    button.style.display = 'none';
    button.addEventListener('click', (event) => {
      options.onToggle();
      (event.currentTarget as HTMLButtonElement).blur();
    });
    markEnglishOnly(button);
    options.anchor.appendChild(button);
    this.button = button;
  }

  /** SOUND: OFF while muted, SOUND: ON otherwise. */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.button.textContent = t(muted ? 'titleSound.off' : 'titleSound.on');
  }

  /** Shows or hides the button; a no-op unless that changes. */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.button.style.display = shown ? 'block' : 'none';
    if (!shown && document.activeElement === this.button) this.button.blur();
  }
}
