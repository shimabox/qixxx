// The game's language and its text lookup (src/i18n/messages.ts).
//
// The language is decided once, when the page loads (main.ts calls
// setLocale(detectLocale(...)) before building any UI), and never changes
// afterwards. No DOM here: the page's address and the browser's languages
// are passed in, so all of it runs in unit tests too. src/core/ and
// functions/ never import it — what is simulated, stored or sent never
// depends on the language.
import { JA_TEXT_FONT_FAMILY } from '../config';
import { messages, type MessageKey, type Messages } from './messages';

export type { MessageKey } from './messages';

export type Locale = 'en' | 'ja';

/**
 * The page's language: `?lang=ja` / `?lang=en` in `search` when present,
 * otherwise Japanese when the browser's first language is Japanese (`ja`,
 * `ja-JP`, ...), English for anything else.
 */
export function detectLocale(search: string, languages: readonly string[]): Locale {
  const lang = new URLSearchParams(search).get('lang');
  if (lang === 'ja' || lang === 'en') return lang;
  const first = languages[0] ?? '';
  return first.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let current: Locale = 'en';

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

type ArgsOf<K extends MessageKey> = Messages[K]['en'] extends (...args: infer A) => string ? A : [];

/** The text of `key` in the current language, filled with `args` for a key that takes some. */
export function t<K extends MessageKey>(key: K, ...args: ArgsOf<K>): string {
  const value = messages[key][current] as string | ((...values: unknown[]) => string);
  return typeof value === 'function' ? value(...args) : value;
}

/**
 * The font for the Japanese sentences on the page (the device's own
 * Japanese fonts), or null in English, where the elements keep the fonts
 * they already have.
 */
export function sentenceFontFamily(): string | null {
  return current === 'ja' ? JA_TEXT_FONT_FAMILY : null;
}
