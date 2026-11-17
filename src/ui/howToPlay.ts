// HOW TO PLAY: a button on the Title screen (the field's top-left corner,
// across from RANKING) that opens a one-screen panel of four small pictures
// — draw, close, the side without enemies, the split — each with one line,
// and a line on the goal and the time. It never opens by itself.
//
// While the panel is open, and for HOW_TO_CLOSE_GUARD_TICKS ticks after it
// closes, every confirm (a key, a tap on the field, a touch button) is
// dropped, so the key or tap that closes it does not also start a run. A key
// pressed while it is open, the closing key included, counts as a press again
// only once released, so holding it past the wait does not start a run
// either. The panel's backdrop covers the whole page, the touch controls
// included.
import { t } from '../i18n';
import { applySentenceFont, markEnglishOnly } from './sentenceFont';
import { stopKeyPropagation } from './ranking';
import {
  COLOR_BACKGROUND,
  COLOR_BORDER,
  COLOR_CLAIMED_FAST,
  COLOR_LINE,
  COLOR_MARKER,
  COLOR_WISP_HEAD,
  COLOR_FX_SPLIT,
  FX_TEXT_FONT_FAMILY,
  HOW_TO_CLOSE_GUARD_TICKS,
  HUD_ACCENT_COLOR,
  HUD_FONT,
  HUD_TEXT_COLOR,
  TITLE_BUTTON_COMPACT_FONT_PX,
  TITLE_BUTTON_COMPACT_INSET_PX,
  TITLE_BUTTON_COMPACT_PADDING,
} from '../config';
import type { MessageKey } from '../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Gap between the two title buttons, and from the field's edges.
const BUTTON_INSET_PX = 8;
// The panel's room from the screen's edges.
const PANEL_MARGIN_PX = 8;
// A landscape screen lower than this lays the four pictures in one row.
const PANEL_ONE_ROW_BELOW_PX = 600;
// The panel's height besides the pictures: padding, heading, goal line (two
// lines), pause line (one), CLOSE and the gaps; and per row of pictures, its
// lines (three).
const PANEL_TEXT_ALLOWANCE_PX = 176;
const PANEL_CAPTION_ALLOWANCE_PX = 64;
// The pictures' height (CSS px) at most, and at least however low the screen.
const PICTURE_MAX_HEIGHT_PX = 150;
const PICTURE_MIN_HEIGHT_PX = 54;

export interface HowToPlayOptions {
  /** #canvas-wrap: the button sits in its top-left corner. */
  anchor: HTMLElement;
  /** The RANKING button, to stay clear of it. */
  getRankingButton: () => HTMLElement | null;
  /** A touch device: the touch wording of the first line. */
  touch: boolean;
  /** Called when the panel opens (closes the ranking list). */
  onOpen: () => void;
}

/**
 * Decides when confirms are taken again once the panel closes. Kept apart
 * from the DOM so it can be unit tested.
 *
 * - Every confirm is dropped while the panel is open and for `guardTicks`
 *   ticks from it closing (dropsConfirm()).
 * - A key pressed while the panel is open — the key that closes it included —
 *   is held back until it is released: its key-downs, the key's auto-repeat
 *   among them, never reach the keyboard input (keyDown()), so holding the
 *   closing key past the wait does not start a run. Released (keyUp()), or
 *   with the window's focus lost (releaseAll()), the key counts as usual
 *   again; a fresh, non-repeat press of a held key also does, as its release
 *   must have been missed.
 */
export class HowToConfirmGuard {
  private open = false;
  private ticksLeft = 0;
  private readonly held = new Set<string>();

  constructor(private readonly guardTicks = HOW_TO_CLOSE_GUARD_TICKS) {}

  setOpen(open: boolean): void {
    if (this.open && !open) this.ticksLeft = this.guardTicks;
    if (open) this.ticksLeft = 0;
    this.open = open;
  }

  /**
   * A key went down (`repeat`: the key's auto-repeat). True when the
   * key-down must not reach the keyboard input as a press.
   */
  keyDown(code: string, repeat: boolean): boolean {
    if (this.open) {
      this.held.add(code);
      return true;
    }
    if (!this.held.has(code)) return false;
    if (repeat) return true;
    this.held.delete(code);
    return false;
  }

  /** A key was released. */
  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** The window lost focus: no key can still be held. */
  releaseAll(): void {
    this.held.clear();
  }

  /** One live tick: true when this tick's confirm must be dropped. */
  dropsConfirm(): boolean {
    if (this.open) return true;
    if (this.ticksLeft > 0) {
      this.ticksLeft--;
      return true;
    }
    return false;
  }
}

export interface HowToPlayPanelLayout {
  /** The pictures' columns: 2 (two rows), or 4 (one row) on a wide, low screen. */
  columns: 2 | 4;
  /** The panel's width (CSS px). */
  panelWidthPx: number;
  /** The largest a picture may be shown (CSS px, 4:3). */
  pictureMaxWidthPx: number;
}

/**
 * The panel's layout on a `width` x `height` screen, so the heading, the four
 * pictures and lines, the goal line and CLOSE are all on it at once: two
 * rows of two on a tall or roomy screen, one row of four on a wide, low one
 * (a phone held sideways), the pictures shrunk to what the height leaves.
 */
export function howToPlayPanelLayout(width: number, height: number): HowToPlayPanelLayout {
  const columns = width > height && height < PANEL_ONE_ROW_BELOW_PX ? 4 : 2;
  const panelWidthPx = Math.floor(Math.min(columns === 4 ? 760 : 560, width - PANEL_MARGIN_PX * 2));
  // The height left for the pictures once the heading, the lines (up to
  // three each), the goal line (up to two), CLOSE and the gaps are counted.
  const rows = columns === 4 ? 1 : 2;
  const forPictures = (height - PANEL_MARGIN_PX * 2 - PANEL_TEXT_ALLOWANCE_PX - rows * PANEL_CAPTION_ALLOWANCE_PX) / rows;
  const pictureMaxHeightPx = Math.max(PICTURE_MIN_HEIGHT_PX, Math.min(PICTURE_MAX_HEIGHT_PX, forPictures));
  return { columns, panelWidthPx, pictureMaxWidthPx: Math.floor((pictureMaxHeightPx * 4) / 3) };
}

/** The four pictures and their lines, in order. */
export function howToPlayLines(touch: boolean): MessageKey[] {
  return [touch ? 'howTo.draw.touch' : 'howTo.draw.key', 'howTo.close', 'howTo.side', 'howTo.split'];
}

/** The line below the goal on how to pause. */
export function howToPlayPauseLine(touch: boolean): MessageKey {
  return touch ? 'howTo.pause.touch' : 'howTo.pause.key';
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

// The pictures: the field as a 160x120 box, in the game's own colours.
function picture(kind: 'draw' | 'close' | 'side' | 'split'): SVGSVGElement {
  const root = svg('svg', { viewBox: '0 0 160 120', 'aria-hidden': 'true' });
  root.classList.add('how-to-play-picture');
  // Its size is set by fitPanel(), keeping the 4:3 box.
  root.style.width = '100%';
  root.style.aspectRatio = '4 / 3';
  root.style.display = 'block';
  root.style.margin = '0 auto';
  root.appendChild(svg('rect', { x: 0, y: 0, width: 160, height: 120, fill: COLOR_BACKGROUND }));
  const fill = (points: string) => root.appendChild(svg('polygon', { points, fill: COLOR_CLAIMED_FAST, opacity: 0.85 }));
  const line = (points: string, color = COLOR_LINE) =>
    root.appendChild(svg('polyline', { points, fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const wisp = (x: number, y: number) => {
    root.appendChild(svg('circle', { class: 'how-to-play-wisp', cx: x, cy: y, r: 9, fill: COLOR_WISP_HEAD, opacity: 0.3 }));
    root.appendChild(svg('circle', { cx: x, cy: y, r: 4.5, fill: COLOR_WISP_HEAD }));
  };
  const marker = (x: number, y: number) =>
    root.appendChild(svg('polygon', { points: `${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}`, fill: COLOR_MARKER }));

  if (kind === 'draw') {
    line('80,4 80,58');
    marker(80, 58);
    wisp(122, 84);
  } else if (kind === 'close') {
    fill('40,4 40,64 104,64 104,4');
    line('40,4 40,64 104,64 104,4', COLOR_BORDER);
    marker(104, 4);
    wisp(118, 94);
  } else if (kind === 'side') {
    fill('4,4 64,4 64,116 4,116');
    line('64,4 64,116', COLOR_BORDER);
    wisp(112, 60);
  } else {
    // CLEAR! sits in the empty top of the picture, clear of the two wisps
    // below, so the line is seen to part them, one on each side.
    line('80,4 80,116');
    wisp(42, 84);
    wisp(120, 78);
    const text = svg('text', {
      x: 80,
      y: 30,
      'text-anchor': 'middle',
      'font-size': 18,
      'font-weight': 700,
      fill: COLOR_FX_SPLIT,
      stroke: COLOR_BACKGROUND,
      'stroke-width': 3,
      'paint-order': 'stroke',
    });
    text.classList.add('how-to-play-clear-mark');
    text.style.fontFamily = FX_TEXT_FONT_FAMILY;
    text.textContent = t('howTo.clearMark');
    root.appendChild(text);
  }
  root.appendChild(svg('rect', { x: 2, y: 2, width: 156, height: 116, fill: 'none', stroke: COLOR_BORDER, 'stroke-width': 3 }));
  return root;
}

// A line that wraps is split into lines of about the same length, so no one
// or two characters are left alone on the last; a Japanese line is broken
// between phrases, not inside a word. A browser without `text-wrap: balance`
// (or `word-break: auto-phrase`) wraps it as before.
function balanceLines(el: HTMLElement): void {
  el.style.setProperty('text-wrap', 'balance');
  el.style.setProperty('word-break', 'auto-phrase');
}

function styledButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  stopKeyPropagation(button);
  button.type = 'button';
  button.textContent = label;
  button.style.font = HUD_FONT;
  button.style.color = HUD_ACCENT_COLOR;
  button.style.background = 'rgba(10, 14, 39, 0.7)';
  button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
  button.style.borderRadius = '4px';
  button.style.cursor = 'pointer';
  button.style.pointerEvents = 'auto';
  button.style.userSelect = 'none';
  return button;
}

export class HowToPlayUI {
  private readonly options: HowToPlayOptions;
  private readonly button: HTMLButtonElement;
  private readonly backdrop: HTMLDivElement;
  private readonly guard = new HowToConfirmGuard();
  // The key-downs kept from the keyboard input (keepsKeyDown()).
  private readonly keptKeyDowns = new WeakMap<Event, boolean>();
  private allowed: boolean | null = null;
  private opened = false;
  private compact = false;
  // Built by buildPanel().
  private panel!: HTMLDivElement;
  private grid!: HTMLDivElement;
  private closeButton!: HTMLButtonElement;
  // The page's elements made inert while the panel is open.
  private inerted: HTMLElement[] = [];

  constructor(options: HowToPlayOptions) {
    this.options = options;
    this.button = this.buildButton();
    this.backdrop = this.buildPanel();
    window.addEventListener('resize', () => {
      if (this.opened) this.fitPanel();
    });
    // Any key but Tab closes it (Tab moves between its controls). The key's
    // own default action is stopped, so an Enter or Space on a focused
    // button does not also press it (and open the panel again). A key
    // pressed while it is open, the closing key included, is kept from the
    // keyboard input (src/input/keyboard.ts) until it is released, so its
    // auto-repeat does not start a run (HowToConfirmGuard, keepsKeyDown()).
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'Tab') return;
        const wasOpen = this.opened;
        if (this.keepsKeyDown(event)) event.preventDefault();
        if (wasOpen) this.close();
      },
      true
    );
    window.addEventListener('keyup', (event) => this.guard.keyUp(event.code), true);
    window.addEventListener('blur', () => this.guard.releaseAll());
  }

  getButton(): HTMLButtonElement {
    return this.button;
  }

  isOpen(): boolean {
    return this.opened;
  }

  /**
   * True for a key-down the keyboard input must not count as a press: a key
   * pressed while the panel is open, until it is released (HowToConfirmGuard).
   * Decided once per key-down, by whichever of this panel's listener and
   * the keyboard input's asks first (a key-down sent to the window itself
   * may reach the keyboard input's listener first), before the panel closes.
   */
  keepsKeyDown(event: Event): boolean {
    const known = this.keptKeyDowns.get(event);
    if (known !== undefined) return known;
    const { code, repeat } = event as KeyboardEvent;
    const kept = code !== 'Tab' && this.guard.keyDown(code, repeat);
    this.keptKeyDowns.set(event, kept);
    return kept;
  }

  /** One live tick: true when this tick's confirm must be dropped (see the module comment). */
  dropsConfirm(): boolean {
    return this.guard.dropsConfirm();
  }

  /** Shows the button only where RANKING is offered (the live Title screen); closes the panel elsewhere. */
  syncAvailability(allowed: boolean): void {
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    this.button.style.display = allowed ? 'block' : 'none';
    if (!allowed) this.close();
    else this.layout();
  }

  open(): void {
    if (!this.allowed || this.opened) return;
    this.options.onOpen();
    this.opened = true;
    this.guard.setOpen(true);
    this.backdrop.style.display = 'flex';
    this.fitPanel();
    // Everything behind the panel is inert while it is open: no Tab stop,
    // no press. Focus starts on CLOSE.
    for (const el of Array.from(document.body.children)) {
      if (el === this.backdrop || !(el instanceof HTMLElement) || el.inert) continue;
      el.inert = true;
      this.inerted.push(el);
    }
    this.closeButton.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.guard.setOpen(false);
    this.backdrop.style.display = 'none';
    for (const el of this.inerted) el.inert = false;
    this.inerted = [];
    // Focus goes back to the page, not to HOW TO PLAY: the next key starts
    // a run as it does on any Title screen.
    if (document.activeElement instanceof HTMLElement && this.backdrop.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  /**
   * The small button for a field shown less than
   * TITLE_BUTTONS_COMPACT_BELOW_PX tall, matching RANKING's
   * (RankingUI.setTitleButtonCompact()): the two then sit in one row along
   * the field's top edge. main.ts calls it whenever the field is resized,
   * before layout().
   */
  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    const s = this.button.style;
    // The roomy values are buildButton()'s own.
    s.fontSize = compact ? `${TITLE_BUTTON_COMPACT_FONT_PX}px` : '1em';
    s.padding = compact ? TITLE_BUTTON_COMPACT_PADDING : '8px 16px';
    s.maxWidth = `calc(100% - ${this.inset() * 2}px)`;
    this.layout();
  }

  private inset(): number {
    return this.compact ? TITLE_BUTTON_COMPACT_INSET_PX : BUTTON_INSET_PX;
  }

  /**
   * Keeps the button clear of RANKING: in the top-left corner when both fit
   * side by side, otherwise right under RANKING in the top-right corner.
   * Called when the button shows and whenever the field is resized.
   */
  layout(): void {
    const ranking = this.options.getRankingButton();
    const s = this.button.style;
    const inset = this.inset();
    s.left = `${inset}px`;
    s.right = '';
    s.top = `${inset}px`;
    if (!ranking || this.button.style.display === 'none' || ranking.style.display === 'none') return;
    const wrap = this.options.anchor.getBoundingClientRect();
    const mine = this.button.getBoundingClientRect();
    const theirs = ranking.getBoundingClientRect();
    if (mine.right + inset <= theirs.left) return;
    s.left = '';
    s.right = `${inset}px`;
    s.top = `${theirs.bottom - wrap.top + inset}px`;
  }

  /** Lays the open panel out for the screen it is on (howToPlayPanelLayout()). */
  private fitPanel(): void {
    const layout = howToPlayPanelLayout(window.innerWidth, window.innerHeight);
    this.panel.style.width = `${layout.panelWidthPx}px`;
    this.grid.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
    for (const svg of Array.from(this.grid.querySelectorAll<SVGSVGElement>('svg.how-to-play-picture'))) {
      svg.style.maxWidth = `${layout.pictureMaxWidthPx}px`;
    }
  }

  private buildButton(): HTMLButtonElement {
    const button = styledButton(t('howTo.button'));
    button.id = 'how-to-play-button';
    // Built like the RANKING button (src/ui/ranking.ts's mountTitleButton()).
    button.style.position = 'absolute';
    button.style.top = `${BUTTON_INSET_PX}px`;
    button.style.left = `${BUTTON_INSET_PX}px`;
    button.style.fontSize = '1em';
    button.style.padding = '8px 16px';
    button.style.maxWidth = `calc(100% - ${BUTTON_INSET_PX * 2}px)`;
    button.style.whiteSpace = 'nowrap';
    button.style.zIndex = '5';
    button.style.display = 'none';
    button.addEventListener('click', (event) => {
      this.open();
      (event.currentTarget as HTMLButtonElement).blur();
    });
    markEnglishOnly(button);
    this.options.anchor.appendChild(button);
    return button;
  }

  private buildPanel(): HTMLDivElement {
    const backdrop = document.createElement('div');
    backdrop.id = 'how-to-play';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.display = 'none';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';
    backdrop.style.background = 'rgba(0, 0, 0, 0.6)';
    // Over everything, the touch controls and the ranking panels included.
    backdrop.style.zIndex = '40';
    backdrop.style.touchAction = 'none';
    // A press on the backdrop (outside the panel) closes it, on the press
    // itself so a touch closes it as surely as a click. It is not a press on
    // the field or a touch button beneath.
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target !== backdrop) return;
      event.preventDefault();
      this.close();
    });
    stopKeyPropagation(backdrop);

    const panel = document.createElement('div');
    panel.id = 'how-to-play-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('howTo.heading'));
    // Its width, the columns and the pictures' size follow the screen (fitPanel()).
    panel.style.boxSizing = 'border-box';
    panel.style.maxHeight = `calc(100vh - ${PANEL_MARGIN_PX * 2}px)`;
    panel.style.overflow = 'hidden';
    panel.style.padding = '10px 14px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.alignItems = 'center';
    panel.style.gap = '8px';
    panel.style.background = 'rgba(10, 14, 39, 0.97)';
    panel.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    panel.style.borderRadius = '8px';
    panel.style.boxShadow = `0 0 16px ${HUD_ACCENT_COLOR}`;
    panel.style.color = HUD_TEXT_COLOR;
    panel.style.font = HUD_FONT;
    panel.style.lineHeight = '1.35';
    panel.style.textAlign = 'center';
    panel.style.userSelect = 'none';

    // Everything but CLOSE. Sized to fit the screen; should it still not,
    // only this part scrolls and CLOSE stays at the panel's bottom.
    const body = document.createElement('div');
    body.id = 'how-to-play-body';
    body.style.flex = '1 1 auto';
    body.style.minHeight = '0';
    body.style.width = '100%';
    body.style.overflowY = 'auto';
    body.style.touchAction = 'pan-y';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.alignItems = 'center';
    body.style.gap = '8px';
    panel.appendChild(body);

    const heading = document.createElement('div');
    heading.textContent = t('howTo.heading');
    heading.style.fontSize = '18px';
    heading.style.fontWeight = 'bold';
    markEnglishOnly(heading);
    body.appendChild(heading);

    const grid = document.createElement('div');
    grid.id = 'how-to-play-steps';
    grid.style.display = 'grid';
    grid.style.gap = '8px 10px';
    grid.style.width = '100%';
    const kinds = ['draw', 'close', 'side', 'split'] as const;
    howToPlayLines(this.options.touch).forEach((key, index) => {
      const step = document.createElement('figure');
      step.className = 'how-to-play-step';
      step.style.margin = '0';
      step.appendChild(picture(kinds[index]));
      const caption = document.createElement('figcaption');
      caption.className = 'how-to-play-text';
      caption.textContent = t(key);
      caption.style.fontSize = '13px';
      caption.style.marginTop = '4px';
      applySentenceFont(caption);
      balanceLines(caption);
      step.appendChild(caption);
      grid.appendChild(step);
    });
    body.appendChild(grid);
    this.grid = grid;

    const goal = document.createElement('div');
    goal.id = 'how-to-play-goal';
    goal.className = 'how-to-play-text';
    goal.textContent = t('howTo.goal');
    goal.style.fontSize = '13px';
    goal.style.opacity = '0.9';
    applySentenceFont(goal);
    balanceLines(goal);
    body.appendChild(goal);

    // How to pause, read like the goal line: P / Esc on a keyboard, the PAUSE
    // button on the touch controls (the same choice as the drawing line's).
    const pause = document.createElement('div');
    pause.id = 'how-to-play-pause';
    pause.className = 'how-to-play-text';
    pause.textContent = t(howToPlayPauseLine(this.options.touch));
    pause.style.fontSize = '13px';
    pause.style.opacity = '0.9';
    applySentenceFont(pause);
    balanceLines(pause);
    body.appendChild(pause);

    const close = styledButton(t('howTo.closeButton'));
    close.id = 'how-to-play-close';
    close.style.flex = '0 0 auto';
    close.style.fontSize = '14px';
    close.style.padding = '6px 16px';
    markEnglishOnly(close);
    close.addEventListener('click', () => this.close());
    panel.appendChild(close);
    this.closeButton = close;

    backdrop.appendChild(panel);
    this.panel = panel;
    // On the page itself: #game-root (and with it #canvas-wrap) clips its overflow.
    document.body.appendChild(backdrop);
    return backdrop;
  }
}
