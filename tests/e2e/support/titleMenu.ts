// Shared helpers for the specs that check the Title menu (src/ui/titleMenu.ts):
// the boxes of the row, its three buttons and what it must keep clear of, and
// the place the row should take, worked out here from those boxes alone —
// never from the row's own height — by the rule the menu follows: under the
// title text, else just under the field, else along the field's bottom edge.
import type { Page } from '@playwright/test';
import {
  TITLE_DEMO_LABEL_BOTTOM_COMPACT_PX,
  TITLE_DEMO_LABEL_COMPACT_BELOW_PX,
  TITLE_DEMO_LABEL_INSET_PX,
  TITLE_MENU_BELOW_GAP_PX,
  TITLE_MENU_GAP_PX,
  TITLE_MENU_INSET_PX,
  TITLE_MENU_MIN_TARGET_PX,
  TOUCH_DPAD_HIT_MARGIN,
} from '../../../src/config';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const MENU_BUTTONS = ['#how-to-play-button', '#ranking-button', '#difficulty-button'] as const;

export const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
export const inside = (a: Box, b: Box): boolean =>
  a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
export const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

/** Everything the Title menu is placed against, as found now (CSS px). */
export interface TitleLayout {
  viewport: Box;
  field: Box;
  root: Box;
  screen: Box;
  menu: Box | null;
  buttons: Box[];
  demo: Box | null;
  hud: Box | null;
  mute: Box | null;
  credit: Box | null;
  /** The touch controls' own boxes (shown ones only). */
  touch: Box[];
  /** The d-pad's hit area: its box grown by TOUCH_DPAD_HIT_MARGIN. */
  dpadHit: Box | null;
}

export async function titleLayout(page: Page): Promise<TitleLayout> {
  const raw = await page.evaluate((buttons) => {
    const b = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
    };
    const q = (s: string) => b(document.querySelector(s));
    return {
      viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight },
      field: q('#game-canvas'),
      root: q('#game-root'),
      screen: q('#screen'),
      menu: q('#title-menu'),
      buttons: buttons.map((s) => q(s)),
      demo: q('#title-demo-label'),
      hud: q('#hud'),
      mute: q('#mute-button'),
      credit: q('#credit-link'),
      touch: [...document.querySelectorAll('#touch-controls button, #touch-dpad')].map((el) => b(el)).filter((x) => x !== null),
      dpad: q('#touch-dpad'),
    };
  }, [...MENU_BUTTONS]);
  const grow = (d: Box | null) =>
    d ? box(d.left - TOUCH_DPAD_HIT_MARGIN, d.top - TOUCH_DPAD_HIT_MARGIN, d.width + TOUCH_DPAD_HIT_MARGIN * 2, d.height + TOUCH_DPAD_HIT_MARGIN * 2) : null;
  return {
    viewport: raw.viewport,
    field: raw.field!,
    root: raw.root!,
    screen: raw.screen!,
    menu: raw.menu,
    buttons: raw.buttons.filter((x): x is Box => x !== null),
    demo: raw.demo,
    hud: raw.hud,
    mute: raw.mute,
    credit: raw.credit,
    touch: raw.touch as Box[],
    dpadHit: grow(raw.dpad),
  };
}

export type Placement = 'under-text' | 'below-field' | 'field-bottom';

/**
 * Where the DEMO tag sits in the field's bottom-left corner — the corner kept
 * free under the title text whether or not the tag shows there. Taken from
 * the shown tag (`demo`, which may have moved to the top-left corner).
 */
export function demoReserve(l: TitleLayout): Box {
  const d = l.demo!;
  const bottomInset = l.field.height < TITLE_DEMO_LABEL_COMPACT_BELOW_PX ? TITLE_DEMO_LABEL_BOTTOM_COMPACT_PX : TITLE_DEMO_LABEL_INSET_PX;
  return box(d.left, l.field.bottom - bottomInset - d.height, d.width, d.height);
}

/** What no part of the row may cover: the touch controls (the d-pad by its hit area), the SOUND button and the credit. */
export function mustAvoid(l: TitleLayout): Box[] {
  return [...l.touch, ...(l.dpadHit ? [l.dpadHit] : []), ...(l.mute ? [l.mute] : []), ...(l.credit ? [l.credit] : [])];
}

/**
 * The height the row needs under the text or under the field: its buttons at
 * least TITLE_MENU_MIN_TARGET_PX tall, or as tall as they are when taller.
 */
export function requiredHeight(l: TitleLayout, column: boolean): number {
  const each = l.buttons.map((b) => Math.max(b.height, TITLE_MENU_MIN_TARGET_PX));
  if (!column) return Math.max(...each);
  // Stacked: the buttons' own heights raised to the minimum, plus the gaps between them.
  const gaps = l.buttons.slice(1).reduce((sum, b, i) => sum + (b.top - l.buttons[i].bottom), 0);
  return each.reduce((a, b) => a + b, 0) + gaps;
}

/** Whether the row fits under the title text, worked out from the boxes. */
export function fitsUnderText(l: TitleLayout, column = false): boolean {
  const width = l.menu!.width;
  const centre = l.field.left + l.field.width / 2;
  const row = box(centre - width / 2, l.screen.bottom + TITLE_MENU_GAP_PX, width, requiredHeight(l, column));
  const room = box(l.field.left + TITLE_MENU_INSET_PX, l.field.top, l.field.width - TITLE_MENU_INSET_PX * 2, l.field.height - TITLE_MENU_INSET_PX);
  return inside(row, room) && !overlaps(row, demoReserve(l)) && mustAvoid(l).every((a) => !overlaps(row, a));
}

/** Whether the row fits just under the field, worked out from the boxes. */
export function fitsBelowField(l: TitleLayout, column = false): boolean {
  const width = l.menu!.width;
  const centre = l.field.left + l.field.width / 2;
  const row = box(centre - width / 2, l.field.bottom + TITLE_MENU_BELOW_GAP_PX, width, requiredHeight(l, column));
  const visible = box(
    Math.max(l.root.left, 0),
    Math.max(l.root.top, 0),
    Math.min(l.root.right, l.viewport.width) - Math.max(l.root.left, 0),
    Math.min(l.root.bottom, l.viewport.height) - Math.max(l.root.top, 0)
  );
  return inside(row, visible) && !overlaps(row, l.screen) && mustAvoid(l).every((a) => !overlaps(row, a));
}

/** The first place the rule allows. */
export function expectedPlacement(l: TitleLayout, column = false): Placement {
  if (fitsUnderText(l, column)) return 'under-text';
  if (fitsBelowField(l, column)) return 'below-field';
  return 'field-bottom';
}

/** The place the row is in, read from its box. */
export function actualPlacement(l: TitleLayout): Placement {
  const m = l.menu!;
  if (m.top >= l.field.bottom) return 'below-field';
  if (Math.abs(m.top - (l.screen.bottom + TITLE_MENU_GAP_PX)) <= 1) return 'under-text';
  return 'field-bottom';
}

/** The element at a point: its id, or its tag when it has none. */
export function hitAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.id || el.tagName.toLowerCase() : '';
  }, { x, y });
}

/** The computed look of each of the three buttons. */
export function menuLook(page: Page) {
  return page.evaluate((buttons) =>
    buttons.map((s) => {
      const c = getComputedStyle(document.querySelector(s)!);
      return {
        borders: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth],
        background: c.backgroundColor,
        backgroundImage: c.backgroundImage,
        decoration: c.textDecorationLine,
        fontPx: parseFloat(c.fontSize),
      };
    }),
  [...MENU_BUTTONS]);
}
