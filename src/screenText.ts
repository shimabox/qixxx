// The Title / STAGE CLEAR overlay (#screen) as two parts: the `body`
// (headings and result rows, English in every language, laid out in the
// HUD's monospace face) and the `hint` under it (the "press any key" line, a
// sentence that is Japanese in Japanese). main.ts writes the two as one text
// in English — the overlay's text is exactly `body + hint` either way — and
// gives the hint its own element in Japanese, so only the sentence takes the
// Japanese font and the result rows keep lining up.
import { t } from './i18n';

export interface ScreenText {
  body: string;
  hint: string;
}

/** The whole overlay text, as #screen's textContent reads it. */
export function screenTextString(text: ScreenText): string {
  return text.body + text.hint;
}

/** The Title screen: `QIXXX`, the high score, and the start prompt. */
export function titleScreenText(hiScore: number): ScreenText {
  return { body: `${t('title.heading')}\n\n${t('title.hiScore', hiScore)}\n\n`, hint: t('title.start') };
}

export const EMPTY_SCREEN_TEXT: ScreenText = { body: '', hint: '' };
