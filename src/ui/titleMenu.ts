// The Title screen's menu (#title-menu): HOW TO PLAY, RANKING and the MODE
// toggle in one row under the title text, left to right in that order (the
// DOM order too, so Tab goes the same way). Plain underlined text with no
// border or ground, quieter than the title text above it.
//
// The row takes the first of three shapes that fits the field's width: the
// roomy row (TITLE_MENU_FONT_PX), the small row (TITLE_BUTTON_COMPACT_FONT_PX,
// no side padding), or the small buttons stacked one under another. It then
// goes in the first of three places that holds it (placeTitleMenu()):
//
// 1. Under the title text, inside the field, clear of the DEMO tag's corner.
// 2. Just under the field, where the page still shows it whole.
// 3. Along the field's bottom edge, over the title text if need be; the DEMO
//    tag then moves to the field's top-left corner.
//
// Wherever it is, it keeps clear of the touch controls' hit areas (wider than
// the controls themselves) and the SOUND button and credit. The place is
// decided again whenever the field is resized and whenever the title text
// changes.
//
// DOM-only, like the rest of src/ui/.
import {
  HUD_ACCENT_COLOR,
  HUD_FONT,
  TITLE_BUTTON_COMPACT_FONT_PX,
  TITLE_MENU_BELOW_GAP_PX,
  TITLE_MENU_BUTTON_GAP_PX,
  TITLE_MENU_COLUMN_GAP_PX,
  TITLE_MENU_COMPACT_BUTTON_GAP_PX,
  TITLE_MENU_FOCUS_OUTLINE_PX,
  TITLE_MENU_FONT_PX,
  TITLE_MENU_GAP_PX,
  TITLE_MENU_INSET_PX,
  TITLE_MENU_MIN_TARGET_PX,
  TITLE_MENU_PADDING_X_PX,
  TITLE_MENU_PADDING_Y_PX,
  TITLE_MENU_UNDERLINE_OFFSET_PX,
  TITLE_MENU_UNDERLINE_THICKNESS_PX,
} from '../config';

/** The row's shape: roomy, small, or the small buttons stacked. */
export type TitleMenuShape = 'row' | 'compact-row' | 'column';
/** Where the row is: under the title text, under the field, or along the field's bottom edge. */
export type TitleMenuPlacement = 'under-text' | 'below-field' | 'field-bottom';

/** A box in page CSS px. */
export interface TitleMenuRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TitleMenuPlacementInput {
  /** The field's box. */
  field: TitleMenuRect;
  /** The title text's box. */
  screen: TitleMenuRect;
  /** Where the DEMO tag sits in the field's bottom-left corner, kept free whether or not it shows. */
  demoReserve: TitleMenuRect;
  /** The part of the page shown unclipped: #game-root's box within the screen. */
  visible: TitleMenuRect;
  /** What the row must never cover: the touch controls' hit areas, the SOUND button, the credit. */
  avoid: readonly TitleMenuRect[];
  /** The row's width. */
  width: number;
  /** The row's height with its buttons at least TITLE_MENU_MIN_TARGET_PX tall. */
  targetHeight: number;
  /** The row's height with no such minimum, for the field's bottom edge. */
  edgeHeight: number;
}

export interface TitleMenuPlacementResult {
  placement: TitleMenuPlacement;
  /** The row's box. */
  rect: TitleMenuRect;
}

const EPSILON = 0.5;

export function rectsOverlap(a: TitleMenuRect, b: TitleMenuRect): boolean {
  return a.left < b.right - EPSILON && b.left < a.right - EPSILON && a.top < b.bottom - EPSILON && b.top < a.bottom - EPSILON;
}

function rectInside(a: TitleMenuRect, b: TitleMenuRect): boolean {
  return a.left >= b.left - EPSILON && a.right <= b.right + EPSILON && a.top >= b.top - EPSILON && a.bottom <= b.bottom + EPSILON;
}

function isEmpty(r: TitleMenuRect): boolean {
  return r.right - r.left <= 0 || r.bottom - r.top <= 0;
}

/**
 * The first place that holds the row, in order: under the title text, under
 * the field, along the field's bottom edge (see the module comment). The row
 * is always centred on the field.
 */
export function placeTitleMenu(input: TitleMenuPlacementInput): TitleMenuPlacementResult {
  const { field, screen, demoReserve, visible, avoid, width } = input;
  const left = (field.left + field.right) / 2 - width / 2;
  const at = (top: number, height: number): TitleMenuRect => ({ left, top, right: left + width, bottom: top + height });
  const clearOfAvoid = (r: TitleMenuRect) => avoid.every((a) => isEmpty(a) || !rectsOverlap(r, a));

  const underText = at(screen.bottom + TITLE_MENU_GAP_PX, input.targetHeight);
  const inField: TitleMenuRect = {
    left: field.left + TITLE_MENU_INSET_PX,
    top: field.top,
    right: field.right - TITLE_MENU_INSET_PX,
    bottom: field.bottom - TITLE_MENU_INSET_PX,
  };
  if (rectInside(underText, inField) && !rectsOverlap(underText, demoReserve) && clearOfAvoid(underText)) {
    return { placement: 'under-text', rect: underText };
  }

  const belowField = at(field.bottom + TITLE_MENU_BELOW_GAP_PX, input.targetHeight);
  if (rectInside(belowField, visible) && !rectsOverlap(belowField, screen) && clearOfAvoid(belowField)) {
    return { placement: 'below-field', rect: belowField };
  }

  // Along the bottom edge, raised above whatever reaches up into it from
  // below (the d-pad's wider hit area).
  let bottom = field.bottom - TITLE_MENU_INSET_PX;
  for (let i = 0; i < avoid.length + 1; i++) {
    const r = at(bottom - input.edgeHeight, input.edgeHeight);
    const hit = avoid.filter((a) => !isEmpty(a) && rectsOverlap(r, a));
    if (hit.length === 0) break;
    bottom = Math.min(...hit.map((a) => a.top));
  }
  return { placement: 'field-bottom', rect: at(bottom - input.edgeHeight, input.edgeHeight) };
}

export interface TitleMenuOptions {
  /** #canvas-wrap: the field's own box, and the row's parent. */
  anchor: HTMLElement;
  /** #screen: the title text the row sits under. */
  getScreen: () => HTMLElement;
  /** The DEMO tag: its corner is kept free, and it moves to the top-left corner when the row takes the bottom edge. */
  getDemoLabel: () => HTMLElement;
  /** Puts the DEMO tag in the field's top-left (true) or bottom-left (false) corner. */
  placeDemoLabel: (atTop: boolean) => void;
  /** The part of the page shown unclipped (#game-root's box within the screen). */
  getVisibleRect: () => TitleMenuRect;
  /** What the row must not cover (see TitleMenuPlacementInput.avoid). */
  getAvoidRects: () => TitleMenuRect[];
}

const SHAPES: readonly TitleMenuShape[] = ['row', 'compact-row', 'column'];
const STYLE_ID = 'title-menu-style';

function toRect(r: DOMRect): TitleMenuRect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export class TitleMenu {
  private readonly options: TitleMenuOptions;
  private readonly row: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  private beforeMeasure: () => void = () => {};
  private shown = false;
  private lastKey: string | null = null;

  constructor(options: TitleMenuOptions) {
    this.options = options;
    const row = document.createElement('div');
    row.id = 'title-menu';
    row.style.position = 'absolute';
    row.style.left = '50%';
    row.style.transform = 'translateX(-50%)';
    row.style.width = 'max-content';
    row.style.display = 'none';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'center';
    row.style.pointerEvents = 'none';
    row.style.zIndex = '5';
    options.anchor.appendChild(row);
    this.row = row;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent =
        `#title-menu button:focus-visible { outline: ${TITLE_MENU_FOCUS_OUTLINE_PX}px solid ${HUD_ACCENT_COLOR}; ` +
        `outline-offset: ${TITLE_MENU_FOCUS_OUTLINE_PX}px; }`;
      document.head.appendChild(style);
    }
  }

  getElement(): HTMLDivElement {
    return this.row;
  }

  /**
   * The row's buttons, left to right: they are moved into it in this order
   * and given its look. `beforeMeasure` runs once their size is set and
   * before the row is measured (the MODE toggle reserves its longer label's
   * width).
   */
  setButtons(buttons: HTMLButtonElement[], beforeMeasure: () => void): void {
    this.buttons = buttons;
    this.beforeMeasure = beforeMeasure;
    for (const button of buttons) {
      const s = button.style;
      s.position = 'static';
      s.flex = '0 0 auto';
      s.boxSizing = 'border-box';
      s.font = HUD_FONT;
      s.color = HUD_ACCENT_COLOR;
      s.background = 'transparent';
      s.border = '0';
      s.borderRadius = '0';
      s.textDecorationLine = 'underline';
      s.textDecorationThickness = `${TITLE_MENU_UNDERLINE_THICKNESS_PX}px`;
      s.textUnderlineOffset = `${TITLE_MENU_UNDERLINE_OFFSET_PX}px`;
      s.whiteSpace = 'nowrap';
      s.cursor = 'pointer';
      s.userSelect = 'none';
      s.pointerEvents = 'auto';
      this.row.appendChild(button);
    }
    this.lastKey = null;
  }

  /**
   * Once per rendered frame, after the title text is written: shows the row
   * while any of its buttons shows, and places it again when it has just
   * shown or the title text (`screenKey`) has changed.
   */
  sync(screenKey: string): void {
    const shown = this.buttons.some((b) => b.style.display !== 'none');
    if (!shown) {
      if (this.shown) {
        this.shown = false;
        this.row.style.display = 'none';
      }
      return;
    }
    if (!this.shown || screenKey !== this.lastKey) {
      this.shown = true;
      this.lastKey = screenKey;
      this.layout();
    }
  }

  /** Places the row for the field and the title text as they are now (a resize calls it). */
  layout(): void {
    if (!this.buttons.some((b) => b.style.display !== 'none')) return;
    this.shown = true;
    this.row.style.display = 'flex';
    const field = toRect(this.options.anchor.getBoundingClientRect());
    const room = field.right - field.left - TITLE_MENU_INSET_PX * 2;
    let width = 0;
    for (const shape of SHAPES) {
      this.applyShape(shape, TITLE_MENU_MIN_TARGET_PX);
      width = this.row.getBoundingClientRect().width;
      if (width <= room + EPSILON || shape === 'column') break;
    }
    const targetHeight = this.row.getBoundingClientRect().height;
    this.applyMinHeight(0);
    const edgeHeight = this.row.getBoundingClientRect().height;

    this.options.placeDemoLabel(false);
    const result = placeTitleMenu({
      field,
      screen: toRect(this.options.getScreen().getBoundingClientRect()),
      demoReserve: this.measureDemoLabel(),
      visible: this.options.getVisibleRect(),
      avoid: this.options.getAvoidRects(),
      width,
      targetHeight,
      edgeHeight,
    });
    if (result.placement !== 'field-bottom') this.applyMinHeight(TITLE_MENU_MIN_TARGET_PX);
    this.row.style.top = `${result.rect.top - field.top}px`;
    this.options.placeDemoLabel(result.placement === 'field-bottom');
  }

  private applyShape(shape: TitleMenuShape, minHeight: number): void {
    const compact = shape !== 'row';
    this.row.style.flexDirection = shape === 'column' ? 'column' : 'row';
    this.row.style.gap = `${shape === 'row' ? TITLE_MENU_BUTTON_GAP_PX : shape === 'compact-row' ? TITLE_MENU_COMPACT_BUTTON_GAP_PX : TITLE_MENU_COLUMN_GAP_PX}px`;
    for (const button of this.buttons) {
      button.style.fontSize = `${compact ? TITLE_BUTTON_COMPACT_FONT_PX : TITLE_MENU_FONT_PX}px`;
      button.style.padding = `${TITLE_MENU_PADDING_Y_PX}px ${compact ? 0 : TITLE_MENU_PADDING_X_PX}px`;
    }
    this.applyMinHeight(minHeight);
    this.beforeMeasure();
  }

  private applyMinHeight(px: number): void {
    for (const button of this.buttons) button.style.minHeight = `${px}px`;
  }

  // The DEMO tag's box in its bottom-left corner, measured unseen when it is
  // not showing.
  private measureDemoLabel(): TitleMenuRect {
    const label = this.options.getDemoLabel();
    if (label.style.display !== 'none') return toRect(label.getBoundingClientRect());
    const { display, visibility } = label.style;
    label.style.visibility = 'hidden';
    label.style.display = 'block';
    const rect = toRect(label.getBoundingClientRect());
    label.style.display = display;
    label.style.visibility = visibility;
    return rect;
  }
}
