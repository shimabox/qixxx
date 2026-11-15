// The impact feedback's display face (index.html's @font-face "Orbitron",
// served from public/fonts/). Canvas text does not start a web font loading
// by itself, so the two weights the effects use are requested at start-up.
// Until they arrive — or if they never do — text is drawn in the monospace
// fallback of FX_TEXT_FONT_FAMILY; nothing here ever throws.
//
// Text drawn once and kept (fxLayer.ts's SPLIT! cache) is keyed by
// fxFontEpoch(), which changes whenever a font finishes loading, so it is
// drawn again in the real face.
import { FX_TEXT_FONT_FAMILY } from '../config';

const FX_FONT_LOADS = ['900 16px "Orbitron"', '700 16px "Orbitron"'];

let epoch = 0;

/** Changes every time a web font finishes loading. */
export function fxFontEpoch(): number {
  return epoch;
}

/** A Canvas/CSS `font` value in the effects' face. */
export function fxFont(weight: 700 | 900, px: number): string {
  return `${weight} ${px}px ${FX_TEXT_FONT_FAMILY}`;
}

/** Starts loading the effects' face. Safe without the Font Loading API and when the font cannot be loaded. */
export function loadFxFonts(doc: Document = document): void {
  const fonts = (doc as Partial<Pick<Document, 'fonts'>>).fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const bump = (): void => {
    epoch++;
  };
  try {
    fonts.addEventListener?.('loadingdone', bump);
  } catch {
    // No events: the load promises below still bump the epoch.
  }
  for (const spec of FX_FONT_LOADS) {
    try {
      fonts.load(spec).then(bump, () => {
        // Not available (offline, blocked, missing): the fallback stays.
      });
    } catch {
      // A browser that rejects the request outright: the fallback stays.
    }
  }
}
