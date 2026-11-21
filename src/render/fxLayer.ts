// Draws the impact feedback (src/fx/director.ts's FxFrame) on the game
// canvas: the closed line's glow and the split flash, the vanished line's
// shards, the sparks, the "+score" popups with their praise word and chain
// count, BIG CLAIM / CLOSE CALL, SPLIT!, the stage title and the miss flash. Called by Renderer in its draw order;
// every function takes logical (CANVAS_WIDTH x CANVAS_HEIGHT) coordinates
// and leaves the context state as it found it.
//
// The text is neon: the bundled display face (fxFonts.ts), drawn letter by
// letter so its letter spacing does not depend on Canvas support for it.
// Large text (SPLIT!, the praise word) is three glowing outlines — magenta,
// cyan and a white core — like a neon tube; small text (the score, x2,
// CHAIN) is a glowing fill instead, since outlines alone would not read at
// that size. How the text tears and splits its colours comes from the frame
// (src/fx/textGlitch.ts); nothing here decides timing.
import type { Point } from '../core/field';
import type {
  FxClaimTags,
  FxFlash,
  FxLineGlow,
  FxMissReason,
  FxPopup,
  FxShard,
  FxSpark,
  FxSplitBanner,
  FxStageTitle,
} from '../fx/director';
import { fxFont, fxFontEpoch } from './fxFonts';
import { praiseText } from '../fx/params';
import { sentenceFontFamily, t } from '../i18n';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  RENDER_SCALE,
  COLOR_LINE,
  COLOR_FX_FLASH_LIGHT,
  COLOR_FX_FLASH_DARK,
  COLOR_FX_OUTLINE,
  COLOR_FX_NEON_CYAN,
  COLOR_FX_NEON_MAGENTA,
  COLOR_FX_NEON_CORE,
  COLOR_FX_TEXT_FILL,
  COLOR_FX_MISS_REASON,
  COLOR_FX_BIG_CLAIM,
  COLOR_FX_CLOSE_CALL,
  COLOR_BORDER,
} from '../config';

const GRID_W = CANVAS_WIDTH / RENDER_SCALE;
const GRID_H = CANVAS_HEIGHT / RENDER_SCALE;
const POPUP_FONT_PX = 22;
const POPUP_NOTE_FONT_PX = 14;
const POPUP_RISE_PX = 28;
const POPUP_SPACING = 0.07; // letter spacing of the small text, of its font size
const POPUP_GLOW = 0.43; // glow of the small text, of its font size
const PRAISE_FONT_SHARE = 1.3; // of the score's font size
const CHAIN_FONT_SHARE = 0.6;
const splitText = (): string => t('fx.split');
const SPLIT_WIDTH_SHARE = 0.6; // of the field width, letter spacing included
const SPLIT_SPACING = 0.14; // of its font size
const EDGE_PAD_PX = 6; // text kept this far inside the field

export interface PopupFontSizes {
  scorePx: number;
  notePx: number;
  praisePx: number;
  chainPx: number;
}

/**
 * The popup texts' canvas font sizes at bounce `scale`. `minFontPx` is the
 * smallest canvas size that still reads at the smallest on-screen size
 * (FX_TEXT_MIN_DISPLAY_PX / the field's display scale — see
 * Renderer.setFxTextMinFontPx()): each text is raised to it when the field is
 * shown small (a phone), and keeps its own size otherwise.
 */
export function popupFontSizes(scale: number, minFontPx = 0): PopupFontSizes {
  const size = (base: number) => Math.max(base * scale, minFontPx);
  return {
    scorePx: size(POPUP_FONT_PX),
    notePx: size(POPUP_NOTE_FONT_PX),
    praisePx: size(POPUP_FONT_PX * PRAISE_FONT_SHARE),
    chainPx: size(POPUP_FONT_PX * CHAIN_FONT_SHARE),
  };
}

function cellCenter(c: Point): { x: number; y: number } {
  return { x: (c.x + 0.5) * RENDER_SCALE, y: (c.y + 0.5) * RENDER_SCALE };
}

/** The closed line glowing white (and, for a split, extended to the field edges). */
export function drawLineGlows(ctx: CanvasRenderingContext2D, glows: readonly FxLineGlow[]): void {
  if (glows.length === 0) return;
  ctx.save();
  ctx.fillStyle = COLOR_FX_FLASH_LIGHT;
  ctx.strokeStyle = COLOR_FX_FLASH_LIGHT;
  ctx.shadowColor = COLOR_FX_FLASH_LIGHT;
  for (const glow of glows) {
    if (glow.cells.length === 0 || glow.intensity <= 0) continue;
    ctx.globalAlpha = Math.min(1, glow.intensity);
    if (glow.extendToEdges) {
      ctx.shadowBlur = 16;
      ctx.lineWidth = RENDER_SCALE * 1.5;
      ctx.lineCap = 'square';
      ctx.beginPath();
      for (const [from, dir] of lineEnds(glow.cells)) {
        const start = cellCenter(from);
        const end = cellCenter(walkToEdge(from, dir));
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 8;
    const pad = RENDER_SCALE * 0.25;
    for (const c of glow.cells) {
      ctx.fillRect(c.x * RENDER_SCALE - pad, c.y * RENDER_SCALE - pad, RENDER_SCALE + pad * 2, RENDER_SCALE + pad * 2);
    }
  }
  ctx.restore();
}

/** Both ends of a line with the direction pointing away from the line. */
function lineEnds(cells: readonly Point[]): Array<[Point, { dx: number; dy: number }]> {
  if (cells.length === 1) {
    return [
      [cells[0], { dx: 0, dy: -1 }],
      [cells[0], { dx: 0, dy: 1 }],
    ];
  }
  const first = cells[0];
  const second = cells[1];
  const last = cells[cells.length - 1];
  const beforeLast = cells[cells.length - 2];
  return [
    [first, { dx: Math.sign(first.x - second.x), dy: Math.sign(first.y - second.y) }],
    [last, { dx: Math.sign(last.x - beforeLast.x), dy: Math.sign(last.y - beforeLast.y) }],
  ];
}

function walkToEdge(from: Point, dir: { dx: number; dy: number }): Point {
  if (dir.dx === 0 && dir.dy === 0) return from;
  let x = from.x;
  let y = from.y;
  while (x + dir.dx >= 0 && x + dir.dx < GRID_W && y + dir.dy >= 0 && y + dir.dy < GRID_H) {
    x += dir.dx;
    y += dir.dy;
  }
  return { x, y };
}

/** The vanished line's cells, breaking away and fading. */
export function drawShards(ctx: CanvasRenderingContext2D, shards: readonly FxShard[]): void {
  if (shards.length === 0) return;
  ctx.save();
  ctx.fillStyle = COLOR_LINE;
  ctx.shadowColor = COLOR_LINE;
  ctx.shadowBlur = 4;
  for (const s of shards) {
    if (s.alpha <= 0) continue;
    ctx.globalAlpha = s.alpha;
    const size = RENDER_SCALE * (0.6 + 0.4 * s.alpha);
    const cx = (s.x + 0.5 + s.offsetX) * RENDER_SCALE;
    const cy = (s.y + 0.5 + s.offsetY) * RENDER_SCALE;
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  }
  ctx.restore();
}

const SPARK_FROM = hexToRgb(COLOR_FX_NEON_CORE);
const SPARK_TO = hexToRgb(COLOR_FX_NEON_CYAN);

/** Sparks flying off the closed line: white turning cyan, shrinking and fading, added onto what is below. */
export function drawSparks(ctx: CanvasRenderingContext2D, sparks: readonly FxSpark[]): void {
  if (sparks.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const s of sparks) {
    if (s.alpha <= 0 || s.size <= 0) continue;
    const t = Math.max(0, Math.min(1, s.progress));
    const r = Math.round(SPARK_FROM.r + (SPARK_TO.r - SPARK_FROM.r) * t);
    const g = Math.round(SPARK_FROM.g + (SPARK_TO.g - SPARK_FROM.g) * t);
    const b = Math.round(SPARK_FROM.b + (SPARK_TO.b - SPARK_FROM.b) * t);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.globalAlpha = s.alpha;
    const size = s.size * RENDER_SCALE;
    ctx.fillRect(s.x * RENDER_SCALE - size / 2, s.y * RENDER_SCALE - size / 2, size, size);
  }
  ctx.restore();
}

// --- Text ------------------------------------------------------------------

/**
 * One line of letter-spaced text for the font set on the context. Where
 * Canvas supports `letterSpacing` the line is drawn in one call (each glowing
 * call is a blur, so this keeps the cost down); elsewhere it is drawn letter
 * by letter from `offsets`.
 */
interface SpacedText {
  text: string;
  /** Drawn in one call with the context's letterSpacing. */
  whole: boolean;
  chars: string[];
  /** Left edge of each letter from the left edge of the text (letter by letter only). */
  offsets: number[];
  /** Without the spacing after the last letter. */
  width: number;
}

type LetterSpacingContext = CanvasRenderingContext2D & { letterSpacing?: string };

function layoutSpaced(ctx: CanvasRenderingContext2D, text: string, spacingPx: number): SpacedText {
  const spaced = ctx as LetterSpacingContext;
  if (typeof spaced.letterSpacing === 'string') {
    spaced.letterSpacing = `${spacingPx}px`;
    // measureText() counts the spacing after the last letter as well.
    const width = Math.max(0, ctx.measureText(text).width - spacingPx);
    return { text, whole: true, chars: [], offsets: [], width };
  }
  const chars = Array.from(text);
  const offsets: number[] = [];
  let x = 0;
  chars.forEach((ch, i) => {
    offsets.push(x);
    x += ctx.measureText(ch).width + (i < chars.length - 1 ? spacingPx : 0);
  });
  return { text, whole: false, chars, offsets, width: x };
}

/** Draws `text` centered on (cx, cy); textAlign must be 'left', textBaseline 'middle'. */
function paintSpaced(ctx: CanvasRenderingContext2D, text: SpacedText, cx: number, cy: number, mode: 'fill' | 'stroke'): void {
  const left = cx - text.width / 2;
  if (text.whole) {
    if (mode === 'fill') ctx.fillText(text.text, left, cy);
    else ctx.strokeText(text.text, left, cy);
    return;
  }
  text.chars.forEach((ch, i) => {
    if (mode === 'fill') ctx.fillText(ch, left + text.offsets[i], cy);
    else ctx.strokeText(ch, left + text.offsets[i], cy);
  });
}

/** Canvas shadows ignore the transform; scale glows by it so they match the text at any devicePixelRatio. */
function shadowScale(ctx: CanvasRenderingContext2D): number {
  const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  return t ? Math.hypot(t.a, t.b) || 1 : 1;
}

/**
 * The neon tube: three glowing outlines — magenta (widest), cyan, and a
 * thin white core — the magenta one moved `channelPx` to the right and the
 * cyan one as far to the left.
 */
function strokeNeon(ctx: CanvasRenderingContext2D, text: SpacedText, cx: number, cy: number, fontPx: number, channelPx: number): void {
  const glow = shadowScale(ctx);
  const layers: Array<[string, number, number, number]> = [
    [COLOR_FX_NEON_MAGENTA, fontPx * 0.083, fontPx * 0.4, channelPx],
    [COLOR_FX_NEON_CYAN, fontPx * 0.042, fontPx * 0.17, -channelPx],
    [COLOR_FX_NEON_CORE, Math.max(1, fontPx * 0.015), fontPx * 0.05, 0],
  ];
  for (const [color, width, blur, dx] of layers) {
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur * glow;
    ctx.lineWidth = width;
    paintSpaced(ctx, text, cx + dx, cy, 'stroke');
  }
}

/**
 * Small glowing text: a dark edge, then — while `channelOffset` is above 0 —
 * magenta and cyan copies added either side, then the pale fill glowing in
 * `glowColor`.
 */
function fillGlowText(
  ctx: CanvasRenderingContext2D,
  label: string,
  cx: number,
  cy: number,
  fontPx: number,
  weight: 700 | 900,
  glowColor: string,
  channelOffset: number
): void {
  ctx.font = fxFont(weight, fontPx);
  const text = layoutSpaced(ctx, label, fontPx * POPUP_SPACING);
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(3, fontPx * 0.23);
  ctx.strokeStyle = COLOR_FX_OUTLINE;
  paintSpaced(ctx, text, cx, cy, 'stroke');
  if (channelOffset > 0) {
    const shift = channelOffset * fontPx;
    const previous = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = COLOR_FX_NEON_MAGENTA;
    paintSpaced(ctx, text, cx + shift, cy, 'fill');
    ctx.fillStyle = COLOR_FX_NEON_CYAN;
    paintSpaced(ctx, text, cx - shift, cy, 'fill');
    ctx.globalCompositeOperation = previous;
  }
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = fontPx * POPUP_GLOW * shadowScale(ctx);
  ctx.fillStyle = COLOR_FX_TEXT_FILL;
  paintSpaced(ctx, text, cx, cy, 'fill');
  ctx.shadowBlur = 0;
}

/**
 * "+score" popups, floating up and fading out, each bouncing in at the
 * size the frame gives: NICE! / GREAT! / AWESOME! above for a large enough
 * claim, x2 (slow line) and CHAIN xN (claims in a row) below. `positionOf`
 * gives the popup's center in cells (the centroid of the cells it was
 * scored for). The group is kept inside the field. `minFontPx`: see
 * popupFontSizes().
 */
export function drawPopups(
  ctx: CanvasRenderingContext2D,
  popups: readonly FxPopup[],
  positionOf: (popup: FxPopup) => { x: number; y: number },
  minFontPx = 0
): void {
  if (popups.length === 0) return;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const popup of popups) {
    const at = positionOf(popup);
    const { scorePx, notePx, praisePx, chainPx } = popupFontSizes(popup.scale, minFontPx);

    // Rows relative to the score's center, top to bottom.
    const praiseDy = popup.praise ? -(scorePx * 0.5 + praisePx * 0.62) : 0;
    const noteDy = popup.note ? scorePx * 0.85 : 0;
    const chainDy = popup.chain ? (popup.note ? noteDy + notePx * 0.5 : scorePx * 0.5) + chainPx * 0.85 : 0;

    // Kept inside the field sideways by the widest of the score, the note
    // and CHAIN xN (no less than the margin it always had), and up and down
    // by its rows.
    const { x, y } = popupPlacement(ctx, popup, at, minFontPx);
    ctx.globalAlpha = popup.progress < 0.7 ? 1 : Math.max(0, (1 - popup.progress) / 0.3);

    if (popup.praise) {
      ctx.font = fxFont(900, praisePx);
      const praise = layoutSpaced(ctx, praiseText(popup.praise), praisePx * SPLIT_SPACING);
      const half = praise.width / 2 + praisePx * 0.2;
      const px = clamp(x, EDGE_PAD_PX + half, CANVAS_WIDTH - EDGE_PAD_PX - half);
      strokeNeon(ctx, praise, px, y + praiseDy, praisePx, 0);
      ctx.shadowBlur = 0;
    }
    fillGlowText(ctx, popup.text, x, y, scorePx, 700, COLOR_FX_NEON_CYAN, popup.channelOffset);
    if (popup.note) {
      fillGlowText(ctx, popup.note, x, y + noteDy, notePx, 700, COLOR_FX_NEON_MAGENTA, popup.channelOffset);
    }
    if (popup.chain) {
      fillGlowText(ctx, popup.chain, x, y + chainDy, chainPx, 700, COLOR_FX_NEON_MAGENTA, 0);
    }
  }
  ctx.restore();
}

// --- BIG CLAIM / CLOSE CALL and the stage title ----------------------------

/** A drawn text's box, in logical canvas pixels. */
export interface FxTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A band of the field (logical canvas pixels, top to bottom) that the labels below keep out of: the hint line. */
export interface FxAvoidBand {
  top: number;
  bottom: number;
}

const TAG_FONT_PX = 15;
const TAG_LINE_SHARE = 1.25; // line height, of the font size
const TAG_GAP_PX = 4; // between the score's rows and the tags, at least...
const TAG_GAP_SHARE = 0.35; // ...and this much of the tags' font size
const SPLIT_TAG_GAP_SHARE = 0.75; // a split's tags start this far below the field's middle, of SPLIT!'s size
const STAGE_HEADING_FONT_PX = 34;
const STAGE_NAME_FONT_SHARE = 0.62; // of the heading's
const STAGE_TITLE_CENTER_SHARE = 0.3; // of the field's height, from the top
const STAGE_TITLE_GAP_SHARE = 0.25; // between the heading and the name, of the heading's size

/** The rows of a popup (FxPopup) relative to its score's center, as drawPopups() lays them out. */
function popupRows(popup: FxPopup, sizes: PopupFontSizes): { top: number; bottom: number } {
  const { scorePx, notePx, praisePx, chainPx } = sizes;
  const noteDy = popup.note ? scorePx * 0.85 : 0;
  const chainDy = popup.chain ? (popup.note ? noteDy + notePx * 0.5 : scorePx * 0.5) + chainPx * 0.85 : 0;
  const praiseDy = popup.praise ? -(scorePx * 0.5 + praisePx * 0.62) : 0;
  const top = popup.praise ? praiseDy - praisePx * 0.55 : -scorePx * 0.55;
  const bottom = popup.chain ? chainDy + chainPx * 0.6 : popup.note ? noteDy + notePx * 0.6 : scorePx * 0.55;
  return { top, bottom };
}

/** Where drawPopups() puts a popup's score center, and its rows' extent around it. */
function popupPlacement(
  ctx: CanvasRenderingContext2D,
  popup: FxPopup,
  at: { x: number; y: number },
  minFontPx: number
): { x: number; y: number; top: number; bottom: number } {
  const sizes = popupFontSizes(popup.scale, minFontPx);
  const { top, bottom } = popupRows(popup, sizes);
  let half = 48 - EDGE_PAD_PX;
  for (const [label, px] of [
    [popup.text, sizes.scorePx],
    [popup.note, sizes.notePx],
    [popup.chain, sizes.chainPx],
  ] as const) {
    if (!label) continue;
    ctx.font = fxFont(700, px);
    half = Math.max(half, layoutSpaced(ctx, label, px * POPUP_SPACING).width / 2 + px * 0.2);
  }
  const x = clamp((at.x + 0.5) * RENDER_SCALE, EDGE_PAD_PX + half, CANVAS_WIDTH - EDGE_PAD_PX - half);
  let y = clamp((at.y + 0.5) * RENDER_SCALE - popup.progress * POPUP_RISE_PX, 20, CANVAS_HEIGHT - 28);
  y = clamp(y, EDGE_PAD_PX - top, CANVAS_HEIGHT - EDGE_PAD_PX - bottom);
  return { x, y, top, bottom };
}

/** Moves a box of `height` starting at `top` out of `avoid` (to the side of it with more room) and inside the field. */
function placeVertically(top: number, height: number, avoid: FxAvoidBand | null): number {
  let y = clamp(top, EDGE_PAD_PX, CANVAS_HEIGHT - EDGE_PAD_PX - height);
  if (avoid && y < avoid.bottom && y + height > avoid.top) {
    const roomAbove = avoid.top - EDGE_PAD_PX;
    const roomBelow = CANVAS_HEIGHT - EDGE_PAD_PX - avoid.bottom;
    y = roomAbove >= roomBelow ? avoid.top - height : avoid.bottom;
    y = clamp(y, EDGE_PAD_PX, CANVAS_HEIGHT - EDGE_PAD_PX - height);
  }
  return y;
}

/** Glowing filled text in `font`, centered on (cx, cy), with a dark edge. */
function fillLabel(
  ctx: CanvasRenderingContext2D,
  text: SpacedText,
  cx: number,
  cy: number,
  fontPx: number,
  glowColor: string,
  fillColor: string
): void {
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(3, fontPx * 0.23);
  ctx.strokeStyle = COLOR_FX_OUTLINE;
  paintSpaced(ctx, text, cx, cy, 'stroke');
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = fontPx * POPUP_GLOW * shadowScale(ctx);
  ctx.fillStyle = fillColor;
  paintSpaced(ctx, text, cx, cy, 'fill');
  ctx.shadowBlur = 0;
}

/**
 * The space a claim's popup takes up over its whole life: from where it
 * starts, bounced up to `maxScale`, to where it has risen to at the end. Its
 * center across is where it settles.
 */
function popupFootprint(
  ctx: CanvasRenderingContext2D,
  group: FxClaimTags,
  rows: NonNullable<FxClaimTags['popup']>,
  at: { x: number; y: number },
  minFontPx: number
): { x: number; top: number; bottom: number } {
  const at0 = { ...rows, revealId: group.revealId, anchor: group.anchor, age: 0, channelOffset: 0 };
  const settled = popupPlacement(ctx, { ...at0, progress: 0, scale: 1 }, at, minFontPx);
  let top = settled.y + settled.top;
  let bottom = settled.y + settled.bottom;
  for (const state of [
    { progress: 0, scale: group.popupMaxScale },
    { progress: 1, scale: 1 },
  ]) {
    const place = popupPlacement(ctx, { ...at0, ...state }, at, minFontPx);
    top = Math.min(top, place.y + place.top);
    bottom = Math.max(bottom, place.y + place.bottom);
  }
  return { x: settled.x, top, bottom };
}

/**
 * BIG CLAIM (gold) and CLOSE CALL +N (orange), one line each, just under the
 * claim's popup — above it when there is no room under it — under SPLIT! for
 * a split, or, for another claim with no popup, where the popup would be. Kept inside the field
 * and out of `avoid`. `positionOf` is drawPopups()'s.
 *
 * They never move while shown: they are placed clear of everything their
 * popup covers over its life (FxClaimTags.popup, kept after the popup is
 * gone), for their largest size, and pop in and out around that place's
 * middle. Returns the boxes drawn, for tests.
 */
export function drawClaimTags(
  ctx: CanvasRenderingContext2D,
  claimTags: readonly FxClaimTags[],
  positionOf: (item: { revealId: number; anchor: Point }) => { x: number; y: number },
  minFontPx = 0,
  avoid: FxAvoidBand | null = null
): FxTextBox[] {
  const boxes: FxTextBox[] = [];
  if (claimTags.length === 0) return boxes;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const group of claimTags) {
    if (group.alpha <= 0 || group.tags.length === 0) continue;
    // The place, for the tags at their largest.
    const maxFontPx = Math.max(TAG_FONT_PX * Math.max(group.maxScale, group.scale), minFontPx);
    const maxHeight = maxFontPx * TAG_LINE_SHARE * group.tags.length;
    const gap = Math.max(TAG_GAP_PX, maxFontPx * TAG_GAP_SHARE);

    // Where first: measuring the popup or SPLIT! changes the context's font
    // and letter spacing, so the tags are laid out after it.
    const at = positionOf(group);
    let cx: number;
    let top: number;
    if (group.split) {
      // Under SPLIT! (centred on the field), clear of its letters.
      cx = CANVAS_WIDTH / 2;
      top = CANVAS_HEIGHT / 2 + splitFontPx(ctx, 1) * SPLIT_TAG_GAP_SHARE;
    } else if (group.popup) {
      const foot = popupFootprint(ctx, group, group.popup, at, minFontPx);
      cx = foot.x;
      top = foot.bottom + gap;
      if (top + maxHeight > CANVAS_HEIGHT - EDGE_PAD_PX) top = foot.top - gap - maxHeight;
    } else {
      cx = (at.x + 0.5) * RENDER_SCALE;
      top = (at.y + 0.5) * RENDER_SCALE - maxHeight / 2;
    }

    ctx.font = fxFont(900, maxFontPx);
    const maxHalf =
      Math.max(...group.tags.map((tag) => layoutSpaced(ctx, tag.text, maxFontPx * POPUP_SPACING).width)) / 2 +
      maxFontPx * 0.2;
    const midX = clamp(cx, EDGE_PAD_PX + maxHalf, CANVAS_WIDTH - EDGE_PAD_PX - maxHalf);
    const midY = placeVertically(top, maxHeight, avoid) + maxHeight / 2;

    // Drawn at their size now, around the place's middle.
    const fontPx = Math.max(TAG_FONT_PX * group.scale, minFontPx);
    const lineH = fontPx * TAG_LINE_SHARE;
    const height = lineH * group.tags.length;
    ctx.font = fxFont(900, fontPx);
    const lines = group.tags.map((tag) => layoutSpaced(ctx, tag.text, fontPx * POPUP_SPACING));
    const half = Math.max(...lines.map((l) => l.width)) / 2 + fontPx * 0.2;
    cx = midX;
    top = midY - height / 2;

    ctx.globalAlpha = group.alpha;
    group.tags.forEach((tag, i) => {
      const color = tag.kind === 'big' ? COLOR_FX_BIG_CLAIM : COLOR_FX_CLOSE_CALL;
      fillLabel(ctx, lines[i], cx, top + lineH * (i + 0.5), fontPx, color, color);
    });
    boxes.push({ x: cx - half, y: top, width: half * 2, height });
  }
  ctx.restore();
  return boxes;
}

/**
 * STAGE n and the stage's name, centred across the field a little above its
 * middle (moved out of `avoid`, the hint line, when it is there), popping in
 * and fading as the frame says. STAGE n in the effects' face; the name in
 * the effects' face too in English, in the device's Japanese font in
 * Japanese. Shrunk to fit the field's width. Returns the box drawn.
 */
export function drawStageTitle(
  ctx: CanvasRenderingContext2D,
  title: FxStageTitle,
  minFontPx = 0,
  avoid: FxAvoidBand | null = null
): FxTextBox | null {
  if (title.alpha <= 0) return null;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const family = sentenceFontFamily();
  const nameFont = (px: number) => (family ? `700 ${px}px ${family}` : fxFont(700, px));
  const maxWidth = CANVAS_WIDTH - EDGE_PAD_PX * 2;
  let headingPx = Math.max(STAGE_HEADING_FONT_PX * title.scale, minFontPx / STAGE_NAME_FONT_SHARE);
  const measure = () => {
    const namePx = headingPx * STAGE_NAME_FONT_SHARE;
    ctx.font = fxFont(900, headingPx);
    const heading = layoutSpaced(ctx, title.heading, headingPx * SPLIT_SPACING);
    ctx.font = nameFont(namePx);
    const name = layoutSpaced(ctx, title.title, family ? 0 : namePx * POPUP_SPACING);
    return { namePx, heading, name };
  };
  let m = measure();
  const widest = () => Math.max(m.heading.width + headingPx * 0.4, m.name.width + m.namePx * 0.4);
  if (widest() > maxWidth) {
    headingPx *= maxWidth / widest();
    m = measure();
  }
  const gap = headingPx * STAGE_TITLE_GAP_SHARE;
  const headingH = headingPx * 1.2;
  const nameH = m.namePx * 1.3;
  const height = headingH + gap + nameH;
  const width = widest();
  const top = placeVertically(CANVAS_HEIGHT * STAGE_TITLE_CENTER_SHARE - height / 2, height, avoid);
  const cx = CANVAS_WIDTH / 2;

  // Each line laid out again just before it is drawn: the letter spacing is
  // part of the context, and the last one measured was the other line's.
  ctx.globalAlpha = title.alpha;
  ctx.font = fxFont(900, headingPx);
  const heading = layoutSpaced(ctx, title.heading, headingPx * SPLIT_SPACING);
  fillLabel(ctx, heading, cx, top + headingH / 2, headingPx, COLOR_BORDER, COLOR_FX_TEXT_FILL);
  ctx.font = nameFont(m.namePx);
  const name = layoutSpaced(ctx, title.title, family ? 0 : m.namePx * POPUP_SPACING);
  fillLabel(ctx, name, cx, top + headingH + gap + nameH / 2, m.namePx, COLOR_FX_NEON_CYAN, COLOR_FX_TEXT_FILL);
  ctx.restore();
  return { x: cx - width / 2, y: top, width, height };
}

/** SPLIT!'s font size: letter spacing included, it spans SPLIT_WIDTH_SHARE of the field at pop 1. */
function splitFontPx(ctx: CanvasRenderingContext2D, pop: number): number {
  ctx.font = fxFont(900, 100);
  const natural = layoutSpaced(ctx, splitText(), 100 * SPLIT_SPACING).width || 1;
  return Math.round(((100 * CANVAS_WIDTH * SPLIT_WIDTH_SHARE) / natural) * pop);
}

// SPLIT! is three large blurred outlines, the heaviest thing on the field,
// so it is drawn into an offscreen canvas and copied: once for the steady
// banner, and once per tick (not per band) while it tears. Each slot is
// redrawn when the size, the colour split, the pixel ratio or the loaded
// fonts change.
interface BannerImage {
  canvas: HTMLCanvasElement;
  key: string;
  /** Logical height; the text's center is at height / 2. */
  height: number;
}
const bannerImages: { steady: BannerImage | null; torn: BannerImage | null } = { steady: null, torn: null };

function bannerImage(slot: 'steady' | 'torn', fontPx: number, channelPx: number, scale: number): BannerImage | null {
  const key = `${fontPx}|${channelPx}|${scale}|${fxFontEpoch()}`;
  const current = bannerImages[slot];
  if (current?.key === key) return current;
  if (typeof document === 'undefined') return null;
  const height = Math.ceil(fontPx * 2.6);
  const canvas = current?.canvas ?? document.createElement('canvas');
  canvas.width = Math.ceil(CANVAS_WIDTH * scale);
  canvas.height = Math.ceil(height * scale);
  const off = canvas.getContext('2d');
  if (!off) return null;
  off.setTransform(scale, 0, 0, scale, 0, 0);
  off.clearRect(0, 0, CANVAS_WIDTH, height);
  off.textAlign = 'left';
  off.textBaseline = 'middle';
  off.lineJoin = 'round';
  off.font = fxFont(900, fontPx);
  const text = layoutSpaced(off, splitText(), fontPx * SPLIT_SPACING);
  strokeNeon(off, text, CANVAS_WIDTH / 2, height / 2, fontPx, channelPx);
  const image = { canvas, key, height };
  bannerImages[slot] = image;
  return image;
}

/**
 * SPLIT! as a neon tube spanning SPLIT_WIDTH_SHARE of the field, popping in
 * over its first tenth and fading over its last fifth. While the frame's
 * glitch tears it, each band is cut out and drawn pushed sideways, with the
 * magenta and cyan outlines drifting apart.
 */
export function drawSplitBanner(ctx: CanvasRenderingContext2D, banner: FxSplitBanner): void {
  const { progress, glitch } = banner;
  const pop = progress < 0.1 ? 1.25 - 2.5 * progress : 1;
  const fade = progress < 0.8 ? 1 : Math.max(0, (1 - progress) / 0.2);
  const alpha = fade * glitch.alpha;
  if (alpha <= 0) return;
  const cy = CANVAS_HEIGHT / 2;

  ctx.save();
  const fontPx = splitFontPx(ctx, pop);
  const steady = glitch.bands.length === 1 && glitch.bands[0].dx === 0 && glitch.channelOffset === 0;
  const channelPx = Math.round(glitch.channelOffset * fontPx * 100) / 100;
  const image = bannerImage(steady ? 'steady' : 'torn', fontPx, channelPx, shadowScale(ctx));
  ctx.globalAlpha = alpha;
  if (image) {
    const top = cy - image.height / 2;
    const ratio = image.canvas.height / image.height; // backing pixels per logical pixel
    for (const band of glitch.bands) {
      // The band's rows of the image (all of it for the steady banner), moved sideways.
      const from = steady ? 0 : Math.max(0, image.height / 2 + band.from * fontPx);
      const to = steady ? image.height : Math.min(image.height, image.height / 2 + band.to * fontPx);
      if (to <= from) continue;
      ctx.drawImage(
        image.canvas,
        0,
        from * ratio,
        image.canvas.width,
        (to - from) * ratio,
        band.dx * fontPx,
        top + from,
        CANVAS_WIDTH,
        to - from
      );
    }
  } else {
    // No offscreen canvas: draw straight onto the field.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = fxFont(900, fontPx);
    const text = layoutSpaced(ctx, splitText(), fontPx * SPLIT_SPACING);
    for (const band of glitch.bands) {
      ctx.save();
      if (!steady) {
        ctx.beginPath();
        ctx.rect(0, cy + band.from * fontPx, CANVAS_WIDTH, (band.to - band.from) * fontPx);
        ctx.clip();
      }
      strokeNeon(ctx, text, CANVAS_WIDTH / 2 + band.dx * fontPx, cy, fontPx, channelPx);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** The miss reason's canvas font size on a field shown at full size. */
export const MISS_REASON_FONT_PX = 16;
// How far the reason sits from the contact cell's center, in cells: clear of
// the marker and the burst around it.
const MISS_REASON_GAP_CELLS = 2.5;

/** The miss reason's canvas font size: its own, raised to `minFontPx` (FX_MISS_REASON_MIN_DISPLAY_PX / the display scale). */
export function missReasonFontPx(minFontPx = 0): number {
  return Math.max(MISS_REASON_FONT_PX, minFontPx);
}

/**
 * The last miss's reason, next to the contact: above it (below it when that
 * would leave the top of the field), moved sideways so the whole text stays on
 * the field. Warning-coloured with a dark edge, so it reads on the dark field
 * and on a claimed area alike; it never moves, since it is there to be read.
 * English uses the effects' face, Japanese the device's Japanese font, both
 * bold. Drawn as one string. `minFontPx`: see missReasonFontPx().
 */
export function drawMissReason(ctx: CanvasRenderingContext2D, reason: FxMissReason, minFontPx = 0): void {
  if (reason.alpha <= 0 || reason.text === '') return;
  const fontPx = missReasonFontPx(minFontPx);
  const family = sentenceFontFamily();
  ctx.save();
  ctx.font = family ? `700 ${fontPx}px ${family}` : fxFont(700, fontPx);
  const spaced = ctx as LetterSpacingContext;
  if (typeof spaced.letterSpacing === 'string') spaced.letterSpacing = '0px';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const edge = Math.max(3, fontPx * 0.25);
  const width = ctx.measureText(reason.text).width;
  const halfW = width / 2 + edge / 2;
  const halfH = fontPx / 2 + edge / 2;
  const contact = cellCenter(reason.anchor);
  const gap = MISS_REASON_GAP_CELLS * RENDER_SCALE + halfH;
  let cy = contact.y - gap;
  if (cy - halfH < EDGE_PAD_PX) cy = contact.y + gap;
  cy = clamp(cy, EDGE_PAD_PX + halfH, CANVAS_HEIGHT - EDGE_PAD_PX - halfH);
  const cx = clamp(contact.x, EDGE_PAD_PX + halfW, CANVAS_WIDTH - EDGE_PAD_PX - halfW);
  const left = cx - width / 2;
  ctx.globalAlpha = reason.alpha;
  ctx.shadowBlur = 0;
  ctx.lineWidth = edge;
  ctx.strokeStyle = COLOR_FX_OUTLINE;
  ctx.strokeText(reason.text, left, cy);
  ctx.shadowColor = COLOR_FX_MISS_REASON;
  ctx.shadowBlur = fontPx * 0.3 * shadowScale(ctx);
  ctx.fillStyle = COLOR_FX_MISS_REASON;
  ctx.fillText(reason.text, left, cy);
  ctx.restore();
}

/** The miss flash: a light burst, then a dark one, centered on the contact. */
export function drawFlash(ctx: CanvasRenderingContext2D, flash: FxFlash): void {
  if (flash.kind === 'none' || flash.intensity <= 0) return;
  const center = flash.center ? cellCenter(flash.center) : { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const radius = Math.hypot(CANVAS_WIDTH, CANVAS_HEIGHT);
  const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
  const color = flash.kind === 'light' ? COLOR_FX_FLASH_LIGHT : COLOR_FX_FLASH_DARK;
  const inner = flash.kind === 'light' ? 0.85 : 0.15;
  const outer = flash.kind === 'light' ? 0.2 : 0.7;
  gradient.addColorStop(0, withAlpha(color, inner * flash.intensity));
  gradient.addColorStop(1, withAlpha(color, outer * flash.intensity));
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(-RENDER_SCALE * 4, -RENDER_SCALE * 4, CANVAS_WIDTH + RENDER_SCALE * 8, CANVAS_HEIGHT + RENDER_SCALE * 8);
  ctx.restore();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
