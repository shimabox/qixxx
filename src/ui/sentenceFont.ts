// Which language an element's text is in, for the fonts the browser picks.
//
// On a Japanese page (<html lang="ja">) the generic `monospace` resolves to a
// Japanese face, whose metrics differ — the HUD would grow a pixel taller and
// shrink the field. The English-only parts (the game area, the touch
// controls, the travelling multiplier) are therefore marked `lang="en"`, and
// each sentence that is Japanese on a Japanese page is marked `lang="ja"` and
// given the device's Japanese fonts. On an English page nothing changes.
import { getLocale, sentenceFontFamily } from '../i18n';

/** A sentence element: in Japanese, the device's Japanese font and `lang="ja"`. */
export function applySentenceFont(el: HTMLElement): void {
  const family = sentenceFontFamily();
  if (!family) return;
  el.style.fontFamily = family;
  el.lang = getLocale();
}

/** An element whose text stays English in every language: `lang="en"` on a Japanese page. */
export function markEnglishOnly(el: HTMLElement): void {
  if (getLocale() !== 'en') el.lang = 'en';
}
