// How the impact feedback's text moves, as pure functions of the ticks since
// the text appeared (0 on the tick it appears): the glitch that tears SPLIT!
// apart for its first ticks, the colour split on the score popup and the
// multiplier flying to the HUD, and the popup's bounce. No DOM, no Canvas,
// no clock and no random numbers — the renderer (src/render/fxLayer.ts) and
// main.ts draw exactly what these return. Every length is relative to the
// text's font size (1 = the font size).
import {
  FX_TEXT_GLITCH_BANNER_TICKS,
  FX_TEXT_GLITCH_POPUP_TICKS,
  FX_POPUP_BOUNCE_SCALE,
  FX_POPUP_BOUNCE_TICKS,
} from '../config';

export interface BannerGlitchBand {
  /** Top of the band, from the text's vertical center (font-size relative; negative is up). */
  from: number;
  /** Bottom of the band. */
  to: number;
  /** How far the band is pushed sideways (font-size relative). */
  dx: number;
}

export interface BannerGlitch {
  bands: BannerGlitchBand[];
  /** The magenta layer moves by +channelOffset, the cyan layer by −channelOffset (font-size relative). */
  channelOffset: number;
  /** Multiplies the text's opacity. */
  alpha: number;
}

const WHOLE_TEXT: readonly BannerGlitchBand[] = [{ from: -1, to: 1, dx: 0 }];

function steady(): BannerGlitch {
  return { bands: WHOLE_TEXT.map((b) => ({ ...b })), channelOffset: 0, alpha: 1 };
}

/**
 * SPLIT!'s glitch on its `tick`-th tick. For the first `glitchTicks` ticks
 * the text is cut into three horizontal bands pushed sideways by turns, the
 * magenta and cyan layers drift apart and it blinks dim on ticks 2 and 5;
 * after that (and always with reduced motion) it is one steady piece.
 */
export function bannerGlitch(tick: number, reducedMotion: boolean, glitchTicks = FX_TEXT_GLITCH_BANNER_TICKS): BannerGlitch {
  if (reducedMotion || tick < 0 || tick >= glitchTicks) return steady();
  const odd = tick % 2 === 1;
  return {
    bands: [
      { from: -0.71, to: -0.24, dx: odd ? 0.19 : -0.14 },
      { from: -0.24, to: 0.17, dx: tick % 3 === 0 ? 0.17 : -0.12 },
      { from: 0.17, to: 0.71, dx: odd ? -0.17 : 0.1 },
    ],
    channelOffset: (10 - tick) * 0.012,
    alpha: tick === 2 || tick === 5 ? 0.45 : 1,
  };
}

/**
 * The colour split on small text (the score popup, the multiplier flying to
 * the HUD) on its `tick`-th tick: shrinking over the first `glitchTicks`
 * ticks, 0 after that and always 0 with reduced motion.
 */
export function popupChannelOffset(tick: number, reducedMotion: boolean, glitchTicks = FX_TEXT_GLITCH_POPUP_TICKS): number {
  if (reducedMotion || tick < 0 || tick >= glitchTicks) return 0;
  return (5 - tick * 0.7) * 0.036;
}

/** The bounce holds its full size for this many ticks before easing back. */
const POPUP_BOUNCE_HOLD_TICKS = 3;

/**
 * The popup's size multiplier on its `tick`-th tick: `scale` for the first
 * three ticks, then straight back to 1 by the last of `ticks` ticks (with
 * the defaults: 1.4 on ticks 0-2, falling to 1.0 on tick 7, 1.0 from then on).
 */
export function popupBounceScale(tick: number, scale = FX_POPUP_BOUNCE_SCALE, ticks = FX_POPUP_BOUNCE_TICKS): number {
  if (tick < 0 || tick >= ticks) return 1;
  const hold = Math.min(POPUP_BOUNCE_HOLD_TICKS, ticks);
  if (tick < hold) return scale;
  const span = ticks - hold; // ticks hold .. ticks-1 ease back, reaching 1 on the last
  return scale + (1 - scale) * ((tick - hold + 1) / span);
}
