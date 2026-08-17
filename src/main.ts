import { GameSession, SessionInput } from './core/session';
import { InputRecorder } from './core/inputRecorder';
import { Renderer } from './render/renderer';
import { KeyboardInput } from './input/keyboard';
import { TouchControls, attachTapToConfirm } from './input/touch';
import { SfxEngine } from './audio/sfx';
import { loadHighScore, saveHighScore } from './storage/highscore';
import { loadMuted, saveMuted } from './storage/settings';
import { RunMode, shouldPersistHighScore, resolveHudModePrefix } from './runMode';
import { parseSeedParam } from './seedParam';
import { initGameOverModal, GameOverModal } from './ui/gameOverModal';
import {
  TICK_RATE,
  TICK_DURATION,
  MAX_FRAME_DELTA,
  HUD_FONT,
  HUD_TEXT_COLOR,
  HUD_ACCENT_COLOR,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  MISS_BLINK_INTERVAL_TICKS,
  HUD_WORST_CASE_STATS_TEXT,
  HUD_TIME_WARNING_TICKS,
  HUD_TIME_WARNING_COLOR,
} from './config';

// Debug hook (docs/plan.md §7.2: "window.__game__...を公開しておくとE2Eが
// 安定する"). Populated once init() runs; only ever read by tests/devtools —
// nothing in src/ reads it back, so it can't create a hidden coupling.
declare global {
  interface Window {
    __game__?: {
      session: GameSession;
      sfx: SfxEngine;
    };
  }
}

// Vertical gap (CSS px) between the HUD row and the canvas (docs/plan.md
// §12.1). Kept as a single constant so fitCanvasToViewport()'s available-
// height calculation stays in sync with the actual flex `gap` applied to
// #game-root below.
const HUD_GAP_PX = 6;

// #hud-row's own internal flex `gap` (between #hud, the credit link, and the
// mute button — see getHudRowElement() below). Kept as a constant, like
// HUD_GAP_PX above, so measureNonHudRowWidth()'s single-line-fit prediction
// (updateHudMode()) stays in sync with the actual CSS value.
const HUD_ROW_GAP_PX = 8;

// Get or create the responsive root that hosts the HUD row + canvas
// (docs/plan.md §5.3/§12.1): a flex child that grows/shrinks to fill
// whatever space is left above the touch controls. Stacked as a column so
// the HUD row sits directly above the canvas; both are centered as a group
// and the canvas is letterboxed inside its wrapper at a fixed 4:3 aspect
// ratio via fitCanvasToViewport() below.
function getGameRootElement(): HTMLDivElement {
  let root = document.getElementById('game-root') as HTMLDivElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'game-root';
    root.style.flex = '1 1 auto';
    root.style.minHeight = '0';
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';
    root.style.gap = `${HUD_GAP_PX}px`;
    root.style.width = '100%';
    root.style.overflow = 'hidden';
    document.body.appendChild(root);
  }
  return root;
}

// Get or create the HUD row (docs/plan.md §12.1 "HUDをフィールド直上に"):
// a flex row holding the HUD text (left, grows) and the MUTE button (right,
// fixed size). Its width is kept exactly in sync with the canvas's on-screen
// (CSS) width by fitCanvasToViewport(), so it always reads as "the same
// width as, and directly above, the field" regardless of viewport shape.
function getHudRowElement(root: HTMLDivElement): HTMLDivElement {
  let row = document.getElementById('hud-row') as HTMLDivElement | null;
  if (!row) {
    row = document.createElement('div');
    row.id = 'hud-row';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.gap = `${HUD_ROW_GAP_PX}px`;
    row.style.boxSizing = 'border-box';
    root.appendChild(row);
  }
  return row;
}

// Get or create the wrapper around the canvas (docs/plan.md §12.1
// "オーバーレイをフィールド中央に"): a `position: relative` box sized
// exactly to the canvas's own on-screen box (it has no other content and no
// explicit size of its own, so as a flex item of #game-root — whose
// align-items is "center", not "stretch" — it shrinks to fit the canvas).
// This gives the #screen overlay a positioning ancestor that *is* the
// field's on-screen box, so `top/left: 50%` on #screen centers over the
// canvas itself rather than the viewport.
function getCanvasWrapElement(root: HTMLDivElement): HTMLDivElement {
  let wrap = document.getElementById('canvas-wrap') as HTMLDivElement | null;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'canvas-wrap';
    wrap.style.position = 'relative';
    wrap.style.display = 'block';
    wrap.style.lineHeight = '0'; // avoid the inline-canvas baseline gap nudging layout
    root.appendChild(wrap);
  }
  return wrap;
}

// Get or create canvas element
function getCanvasElement(wrap: HTMLDivElement): HTMLCanvasElement {
  let canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    wrap.appendChild(canvas);
  }
  return canvas;
}

// Get or create the HUD overlay container (stage/score/occupancy/lives/multiplier, §3.3/§6 M1/M4).
// Holds one, two, or three line elements (see getHudLineElement() below) —
// never wraps text itself. fitCanvasToViewport() reads this row's *height*
// to reserve space for the canvas below it, so the number of lines is
// decided explicitly (updateHudMode(), keyed only off window.innerWidth)
// rather than left to the browser's text wrapping, which would depend on
// the row's own *width* — itself derived from this row's height — creating
// a circular width<->height layout dependency between the HUD row and the
// canvas.
function getHudElement(row: HTMLDivElement): HTMLDivElement {
  let hud = document.getElementById('hud') as HTMLDivElement | null;
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'hud';
    hud.style.color = HUD_TEXT_COLOR;
    hud.style.font = HUD_FONT;
    hud.style.fontSize = 'clamp(10px, 3.2vw, 16px)';
    hud.style.textShadow = `0 0 6px ${HUD_ACCENT_COLOR}`;
    hud.style.pointerEvents = 'none';
    hud.style.userSelect = 'none';
    hud.style.flex = '1 1 auto';
    hud.style.minWidth = '0';
    row.appendChild(hud);
  }
  return hud;
}

// Get or create one HUD text line inside #hud. Each line is its own nowrap
// box (color/font/text-shadow/pointer-events/user-select are inherited from
// #hud, so they don't need repeating here) — kept nowrap+ellipsis even in
// two-line mode as a safety net, though in practice each line's shorter
// two-line-mode text shouldn't need it (docs: "各行はnowrapのままでよい").
function getHudLineElement(hud: HTMLDivElement, id: string): HTMLDivElement {
  let line = document.getElementById(id) as HTMLDivElement | null;
  if (!line) {
    line = document.createElement('div');
    line.id = id;
    line.style.whiteSpace = 'nowrap';
    line.style.overflow = 'hidden';
    line.style.textOverflow = 'ellipsis';
    hud.appendChild(line);
  }
  return line;
}

// Get or create the screen-overlay element (Title / StageClear / GameOver, §4.4/§6 M4),
// centered over the *canvas* (docs/plan.md §12.1), not the viewport.
// Neon text-shadow + a faint glowing box (docs/plan.md §6 M5 visual polish),
// consistent with the canvas's own neon palette (config.ts colors).
function getScreenElement(wrap: HTMLDivElement): HTMLDivElement {
  let screen = document.getElementById('screen') as HTMLDivElement | null;
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'screen';
    // Positioned relative to #canvas-wrap (its nearest positioned ancestor),
    // which is sized exactly to the canvas's own on-screen box — so this
    // centers over the field itself and tracks it through resize/rotation.
    screen.style.position = 'absolute';
    screen.style.top = '50%';
    screen.style.left = '50%';
    screen.style.transform = 'translate(-50%, -50%)';
    screen.style.color = HUD_TEXT_COLOR;
    screen.style.font = HUD_FONT;
    screen.style.textAlign = 'center';
    screen.style.whiteSpace = 'pre-line';
    screen.style.textShadow = `0 0 10px ${HUD_ACCENT_COLOR}, 0 0 20px ${HUD_ACCENT_COLOR}`;
    screen.style.pointerEvents = 'none';
    screen.style.userSelect = 'none';
    wrap.appendChild(screen);
  }
  return screen;
}

// Get or create the credit link (author attribution). Lives inside the HUD row,
// positioned between #hud and #mute-button (left of the mute button). Similar to
// the mute button, it must have pointer-events: auto since the HUD row itself has
// pointer-events: none. Uses a smaller font than the mute button for a modest appearance.
function getCreditLinkElement(row: HTMLDivElement): HTMLAnchorElement {
  let link = document.getElementById('credit-link') as HTMLAnchorElement | null;
  if (!link) {
    link = document.createElement('a');
    link.id = 'credit-link';
    link.href = 'https://x.com/shimabox';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '@shimabox';
    link.style.flex = '0 0 auto';
    link.style.font = HUD_FONT;
    link.style.color = HUD_ACCENT_COLOR;
    link.style.fontSize = '0.8em';
    link.style.opacity = '0.85';
    link.style.textDecoration = 'none';
    link.style.whiteSpace = 'nowrap';
    link.style.pointerEvents = 'auto';
    link.style.userSelect = 'none';
    link.style.cursor = 'pointer';
    row.appendChild(link);
  }
  return link;
}

// Get or create the mute toggle button (docs/plan.md §3.8: "ミュートボタン
// をHUDに置く"). Lives inside the HUD row (docs/plan.md §12.1: "MUTEボタン
// はHUD行の右端に統合") rather than #hud itself (which is pointer-events:
// none), so it stays clickable/tappable while sitting flush with the HUD text.
function getMuteButtonElement(row: HTMLDivElement, onToggle: () => void): HTMLButtonElement {
  let button = document.getElementById('mute-button') as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = 'mute-button';
    button.type = 'button';
    button.style.flex = '0 0 auto';
    button.style.boxSizing = 'border-box'; // see the min-width reservation below
    button.style.font = HUD_FONT;
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.padding = '4px 10px';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    button.addEventListener('click', (event) => {
      onToggle();
      // Return keyboard focus to the game after toggling. Otherwise the
      // persistent HUD button remains focused after a click/tap, and Enter
      // on Title/StageClear both confirms the screen and activates the
      // focused button again, silently undoing the mute at the transition.
      (event.currentTarget as HTMLButtonElement).blur();
    });
    row.appendChild(button);

    // Reserve the width of the longer label ("UNMUTE") up front (P2 fix,
    // user review, 2026-08-13): toggleMute()/updateMuteButtonLabel() below
    // swap this button's text between "MUTE" and "UNMUTE" without ever
    // calling fitCanvasToViewport() again, so — before this fix — flipping
    // to the wider "UNMUTE" label grew the button in place, silently
    // invalidating measureNonHudRowWidth()'s already-computed single-line
    // decision (a borderline viewport could clip only *after* the player
    // muted). Sizing the button to its widest possible content from the
    // start instead means neither label ever changes its rendered width, so
    // toggling can't move anything else in the row and needs no re-layout
    // of its own. Safe to measure here (rather than a hardcoded pixel
    // guess): HUD_FONT is a fixed 16px monospace, not the HUD's own
    // vw-based clamp(), so this button's natural width never depends on
    // window size either.
    button.textContent = 'UNMUTE';
    button.style.minWidth = `${button.getBoundingClientRect().width}px`;
  }
  return button;
}

// Game state
let session: GameSession;
let renderer: Renderer;
let keyboard: KeyboardInput;
let sfx: SfxEngine;
let hud: HTMLDivElement;
let hudLine1: HTMLDivElement;
let hudLine2: HTMLDivElement;
// Narrow-viewport-only 3rd line: TIME (and the SEED mode prefix, see
// resolveHudModePrefix()) gets its own line rather than fighting
// STAGE/SCORE/HI (line 1) or OCCUPANCY/LIVES (line 2) for width — both of
// those were already at/near their character budget at 390px before TIME
// was added, so adding it to either risked silently overflowing past the
// existing E2E-guarded OCCUPANCY/LIVES text (or, on line 1, TIME's own
// text). Shown/hidden together with hudLine2 — see updateHudMode().
let hudLine3: HTMLDivElement;
let screen: HTMLDivElement;
let gameOverModal: GameOverModal;
let muteButton: HTMLButtonElement;
let gameRoot: HTMLDivElement;
let hudRow: HTMLDivElement;
let canvas: HTMLCanvasElement;
let accumulator = 0;
let lastTime = performance.now();
// Tracks the highest value already written to storage, so we only touch
// localStorage when the high score actually changes (docs/plan.md's "core
// never touches localStorage" invariant lives in src/storage/highscore.ts;
// this is just the write-on-change guard, kept here in the DOM-facing layer).
let lastSavedHighScore = 0;
// The most recent tick's merged input (keyboard + touch — see input/touch.ts's
// module comment for how those merge for free), kept around purely so the
// once-per-frame audio update below can read the currently-held line speed
// for the continuous draw tone (docs/plan.md §3.8) without re-deriving it.
let lastInput: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };

// Docs/plan.md §13.3 P3: renderFrame() runs every rendered frame, but the
// values feeding the HUD text only actually change on discrete game events
// (score/stage/lives/multiplier/occupancy), not every frame. Caching the
// last-displayed values lets the (comparatively expensive) textContent write
// be skipped whenever nothing changed, instead of re-serializing + reflowing
// the same string 60 times a second.
let lastHudStage = -1;
let lastHudScore = -1;
let lastHudHi = -1;
let lastHudOccupancy = -1;
let lastHudLives = -1;
let lastHudMultiplier = -1;
// TIME changes far more often than the fields above (roughly every 6 ticks,
// a decisecond at TICK_RATE=60) — cached as a string (not raw ticks) so the
// comparison above stays a single strict-equality check per field, same
// shape as every other lastHud* cache.
let lastHudTime = '';
// Whether the last-30-seconds warning color (docs/plans/2026-08-13-time-
// limit-mode) was applied on the previous write — see updateHud()'s doc
// comment for why this is tracked separately from lastHudTime.
let lastHudTimeWarning = false;

// Whether the HUD is currently rendering as two stacked lines (narrow
// viewports, see HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX) instead of one. Kept as
// a module-level flag rather than re-derived every call so updateHudMode()
// can cheaply detect a *change* and invalidate the lastHud* cache above only
// when the mode itself actually flips (otherwise a value-unchanged render
// frame right after a resize would wrongly skip rewriting the DOM into the
// new line layout).
let hudTwoLineMode = false;

// Same idea for the Title/StageClear/GameOver overlay (docs/plan.md §13.3
// P3): `null` is a sentinel distinct from any real screenText() result
// (including the 'playing' status's own empty string), guaranteeing the
// very first renderFrame() call always writes once.
let lastScreenText: string | null = null;

// GAME OVER modal show/hide edge trigger (docs/plan-cloudflare-x-share.md
// Phase 1): show() is only ever called on the frame `status` first becomes
// 'gameover', hide() only on the frame it stops being 'gameover' — never
// every frame, which would otherwise stomp the modal's own in-flight share
// state (e.g. mid-fetch "POSTING..."/"FAILED - RETRY") each render.
let gameOverModalShown = false;

// SEEDED RUNS. `explicitSeedParam` is read once at init() from `?seed=`;
// when present the whole page load runs as `runMode === 'seeded'` — see
// runMode.ts's module comment for exactly what that gates (qixxx.highScore
// write suppression, the HUD's `SEED <n>` prefix). `runMode` and
// `seededRunSeed` are therefore fixed for the entire page load (set once in
// init(), never reassigned afterward): GameSession's own internal reset
// (triggered by its 'gameover' case) already reuses the same seed, or lack
// thereof, across every retry on its own, so main.ts never needs to swap
// `session` for a new instance.
let explicitSeedParam: number | undefined;
let runMode: RunMode = 'normal';
// The seed value for a 'seeded' run, shown as `SEED <n>` in the HUD
// (runMode.ts's resolveHudModePrefix()). Unused outside runMode === 'seeded'.
let seededRunSeed: number | undefined;

// RANKING (docs/plans/2026-08-16-score-ranking task 2): records every
// PLAYING-tick input of the *current* run, RLE-encoded on demand for a
// ranking POST — see src/ui/ranking.ts's gameover flow (task 4), which reads
// `session.getSeed()` + `inputRecorder.encode()` together while `status`
// is still 'gameover' (both stay valid/unchanged for as long as that lasts —
// see update()'s own seed-requeuing/recorder-reset comments below for why).
const inputRecorder = new InputRecorder();

// Generates a fresh per-run seed for 'normal' mode (docs/plans/2026-08-16-
// score-ranking task 2's confirmed spec: `crypto.getRandomValues()`, not
// Math.random — a normal run's board should be unpredictable/unseedable by
// a player, unlike `?seed=` mode's deliberately-reproducible one). Never
// called for 'seeded' mode, whose single seed comes from the URL instead.
function generateNormalRunSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

// SEEDED RUNS helpers.

/**
 * Formats a tick count as `M:SS.D` (minutes:seconds.deciseconds) — no
 * wall-clock time involved, per core/session.ts's tick timer: 60 ticks =
 * 1s at config.ts's TICK_RATE.
 */
function formatTicks(ticks: number): string {
  const totalDeciseconds = Math.floor((Math.max(0, ticks) / TICK_RATE) * 10);
  const minutes = Math.floor(totalDeciseconds / 600);
  const seconds = Math.floor((totalDeciseconds % 600) / 10);
  const deciseconds = totalDeciseconds % 10;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${deciseconds}`;
}

// Initialize game. init() runs exactly once on page load. All registered
// event listeners and input controllers (TouchControls, KeyboardInput) live
// for the page's lifetime and are intentionally not disposed — this is not
// an SPA embedded context but a full-page app. Should remounting become
// necessary in the future, design and call explicit dispose() methods then.
function init(): void {
  explicitSeedParam = parseSeedParam(new URLSearchParams(window.location.search).get('seed'));
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  if (explicitSeedParam !== undefined) {
    // `?seed=` pins the whole page load to a 'seeded' run — GameSession's
    // own internal reset (triggered by its 'gameover' case) reuses this
    // same seed for every retry (GameOver -> Title -> Playing) on its own,
    // so main.ts never needs to swap `session` mid-page-load.
    runMode = 'seeded';
    seededRunSeed = explicitSeedParam;
    session = new GameSession({ seed: explicitSeedParam, highScore });
  } else {
    // Normal mode's initial Title board (docs/plans/2026-08-16-score-ranking
    // task 2's "初回Titleの盤面生成時"): seeded here, at construction —
    // stage 1's board is already fully built by the time Title is ever
    // shown (see GameSession's own module doc comment), so there's no later
    // "Title -> Playing" moment this could instead hook into.
    session = new GameSession({ seed: generateNormalRunSeed(), highScore });
  }

  gameRoot = getGameRootElement();
  hudRow = getHudRowElement(gameRoot);
  const canvasWrap = getCanvasWrapElement(gameRoot);
  canvas = getCanvasElement(canvasWrap);
  renderer = new Renderer(canvas);
  keyboard = new KeyboardInput();
  // Touch controls dispatch synthetic KeyboardEvents on `window` (their
  // default target), exactly matching KeyboardInput's own listening target
  // above — see input/touch.ts's module comment for how that's a complete
  // merge of the two input sources with no extra glue code.
  new TouchControls(window, document.body);
  attachTapToConfirm(canvas);

  // Appended to #hud-row in this order (hud, creditLink, then muteButton) so the mute
  // button lands at the row's right end (docs/plan.md §12.1: "MUTEボタンは
  // HUD行の右端に統合") and the credit link sits between the HUD text and the mute button.
  // Plain flex layout keeps DOM order as visual order here, with no `order` CSS needed.
  hud = getHudElement(hudRow);
  hudLine1 = getHudLineElement(hud, 'hud-line1');
  hudLine2 = getHudLineElement(hud, 'hud-line2');
  hudLine3 = getHudLineElement(hud, 'hud-line3');
  // Matches `hudTwoLineMode`'s own `false` initial value (module scope)
  // until the real, geometry-based decision runs — see updateHudMode() —
  // from the fitCanvasToViewport() call below (which needs the credit
  // link/muteButton to already exist to measure them, so it can't run any
  // earlier than this point in init()).
  hudLine2.style.display = 'none';
  hudLine3.style.display = 'none';
  screen = getScreenElement(canvasWrap);
  gameOverModal = initGameOverModal(canvasWrap);

  sfx = new SfxEngine(loadMuted());
  getCreditLinkElement(hudRow);
  muteButton = getMuteButtonElement(hudRow, toggleMute);
  updateMuteButtonLabel();
  // Mobile autoplay restrictions (docs/plan.md §3.8): AudioContext can only
  // start/resume from within a user-gesture handler. Every keydown (real or
  // synthetic, from the touch controls) and every pointerdown is such a
  // gesture; resume() is a cheap no-op once the context is already running.
  window.addEventListener('keydown', () => sfx.resume());
  window.addEventListener('pointerdown', () => sfx.resume());

  fitCanvasToViewport();
  window.addEventListener('resize', fitCanvasToViewport);
  window.addEventListener('orientationchange', fitCanvasToViewport);

  window.__game__ = { session, sfx };

  // Debug panel (docs/plan.md §6 M10 / §12.4): dev-tuning only, never
  // shipped to players. The `import.meta.env.DEV` check is a compile-time
  // constant Vite inlines as `false` in a production build, which turns
  // this whole branch (including the dynamic import call) into unreachable
  // dead code that Vite's build strips entirely — see the module comment in
  // src/debug/panel.ts and the "no debug code in dist/" build check.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('debug')) {
    void import('./debug/panel').then(({ initDebugPanel }) => {
      initDebugPanel(() => session, hudRow);
      // The DEBUG badge initDebugPanel() just mounted into hudRow is
      // another non-#hud sibling measureNonHudRowWidth() now has to account
      // for (P2 fix, user review, 2026-08-13) — it mounts asynchronously,
      // well after the fitCanvasToViewport() call above already ran, so
      // without this the single-line decision/HUD sizing would silently
      // keep using its pre-badge width until the next resize/
      // orientationchange. A single one-shot re-run right after mount (not
      // a recurring poll) picks it up immediately.
      fitCanvasToViewport();
    });
  }

  renderFrame();
}

function toggleMute(): void {
  const muted = sfx.toggleMuted();
  saveMuted(muted);
  updateMuteButtonLabel();
}

function updateMuteButtonLabel(): void {
  muteButton.textContent = sfx.isMuted() ? 'UNMUTE' : 'MUTE';
}

// The scale factor fitCanvasToViewport() would apply to CANVAS_WIDTH x
// CANVAS_HEIGHT for a HUD row of the given height — i.e. the same
// width<->height letterboxing math fitCanvasToViewport() itself uses below,
// factored out so wouldSingleLineFit() can *predict* a candidate mode's
// resulting canvas/HUD width before committing to it, without the two
// copies of this formula ever being able to drift apart. Returns 0 (an
// otherwise-impossible scale) when there's no usable space, matching
// fitCanvasToViewport()'s own early-return guard.
function predictCanvasScale(hudRowHeightPx: number): number {
  const availW = gameRoot.clientWidth;
  const availH = gameRoot.clientHeight - hudRowHeightPx - HUD_GAP_PX;
  if (availW <= 0 || availH <= 0) return 0;
  return Math.min(availW / CANVAS_WIDTH, availH / CANVAS_HEIGHT);
}

// The width hudRow's non-#hud children (the credit link, the mute button,
// and — only when `?debug` mounted it, see init() — the DEBUG badge) plus
// #hud-row's own flex gaps between them all take up, regardless of hudRow's
// own width. Sums *every* current child of hudRow except #hud itself,
// rather than naming each sibling individually (P2 fix, user review,
// 2026-08-13: a hardcoded credit-link + mute-button sum silently went stale
// the moment the DEBUG badge was appended after this module's own initial
// layout pass), so any element hudRow ever gains automatically counts here
// too, with no further changes needed here. Safe to measure each child at
// *whatever* width it currently happens to be rendered at, regardless of
// hudRow's own current width: every non-#hud child sets `flex: 0 0 auto`
// (getCreditLinkElement()/getMuteButtonElement()/debug/panel.ts's
// buildDebugBadge()), so none of them stretch or shrink to fit hudRow — no
// need to actually lay hudRow out at a candidate width first.
function measureNonHudRowWidth(): number {
  let width = 0;
  let gapCount = 0;
  for (const child of hudRow.children) {
    if (child === hud) continue;
    width += child.getBoundingClientRect().width;
    gapCount++;
  }
  return width + gapCount * HUD_ROW_GAP_PX;
}

// The natural (unclipped) on-screen width of the single-line HUD text at
// #hud's *current* font-size — itself a function of window.innerWidth alone
// (the clamp(10px, 3.2vw, 16px) in getHudElement()), never of hudRow's own
// width, so this is safe to measure before hudRow has been sized for real.
// Combines config.ts's HUD_WORST_CASE_STATS_TEXT (a deliberately generous
// worst-case STAGE/SCORE/HI/TIME/OCCUPANCY/LIVES/xN digit budget — see that
// constant's doc comment) with the mode prefix (runMode.ts's
// resolveHudModePrefix()) at its own real, already-fixed-for-the-page-load
// value: a 'seeded' run's `SEED <n>  ` can be measured exactly here rather
// than guessed at some hypothetical worst case, since unlike SCORE/HI it can
// never change again once `?seed=` is parsed in init().
function measureRequiredSingleLineWidth(): number {
  const modePrefix = resolveHudModePrefix(runMode, { seededRunSeed });
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'nowrap';
  probe.style.font = window.getComputedStyle(hud).font;
  probe.textContent = `${modePrefix}${HUD_WORST_CASE_STATS_TEXT}`;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  return width;
}

// Whether switching to the single-line layout right now would actually fit
// without clipping (P2 fix, user review, 2026-08-12: a *viewport-width-only*
// threshold, this function's predecessor, can't account for a short
// viewport shrinking the canvas — and with it hudRow, which
// fitCanvasToViewport() keeps in sync with the canvas's own on-screen width
// — via *height* rather than width; a wide-but-short window could then still
// clip a single line the old fixed cutoff assumed would fit).
//
// Predicts the single-line layout's own HUD row height first — temporarily
// toggling hudLine2/hudLine3 off to measure hudRow.offsetHeight, then
// restoring whatever display they had (harmless to do speculatively: the
// caller, updateHudMode(), always overwrites their real final display state
// right after based on the actual decision below). A single-line row's
// height depends only on font-size, which — as measureRequiredSingleLineWidth()
// documents — depends only on window.innerWidth, never on the row's own
// width, so this measurement is valid regardless of whatever hudRow.style.width
// currently holds (stale from a previous call, or not yet set at all on the
// very first one). Feeding that height into predictCanvasScale() (the exact
// math fitCanvasToViewport() itself uses) gives the width a single-line
// hudRow would actually end up with; measureNonHudRowWidth()'s fixed-size
// siblings are subtracted to get #hud's own share, then compared against
// measureRequiredSingleLineWidth().
//
// Cannot oscillate: this is a one-shot, self-consistent calculation purely
// from the current (window.innerWidth, window.innerHeight, #game-root size)
// — it never reads `hudTwoLineMode` or any other previous-decision state, so
// repeated calls during a continuous resize always converge to the same
// answer for the same viewport geometry rather than flip-flopping on their
// own. (Verified live by dragging a browser window's edge across every
// threshold below — see this change's PR notes for the exact viewports
// checked.)
function wouldSingleLineFit(): boolean {
  const prevLine2Display = hudLine2.style.display;
  const prevLine3Display = hudLine3.style.display;
  hudLine2.style.display = 'none';
  hudLine3.style.display = 'none';
  const singleLineRowHeight = hudRow.offsetHeight;
  hudLine2.style.display = prevLine2Display;
  hudLine3.style.display = prevLine3Display;

  const scale = predictCanvasScale(singleLineRowHeight);
  if (scale <= 0) return false;
  const candidateCssWidth = Math.max(1, Math.floor(CANVAS_WIDTH * scale));

  const availableHudWidth = candidateCssWidth - measureNonHudRowWidth();
  return availableHudWidth >= measureRequiredSingleLineWidth();
}

// Re-derive the HUD's line mode (see wouldSingleLineFit() above for the
// decision itself). Called from fitCanvasToViewport() itself, which already
// runs on init + every resize/orientationchange, so no separate listener is
// needed. On an actual mode flip, invalidates the lastHud* cache (so the
// next updateHud() call unconditionally rewrites the DOM into the new line
// layout instead of skipping a no-op-looking value comparison) and
// immediately reflects the new mode into the DOM/cache via updateHud(), so
// hudRow's height already accounts for it by the time fitCanvasToViewport()
// measures hudRow.offsetHeight right after this call.
function updateHudMode(): void {
  const twoLine = !wouldSingleLineFit();
  if (twoLine === hudTwoLineMode) return;

  hudTwoLineMode = twoLine;
  hudLine2.style.display = twoLine ? 'block' : 'none';
  hudLine3.style.display = twoLine ? 'block' : 'none';
  lastHudStage = -1;
  lastHudScore = -1;
  lastHudHi = -1;
  lastHudOccupancy = -1;
  lastHudLives = -1;
  lastHudMultiplier = -1;
  updateHud();
}

// Write the HUD text, skipping the DOM write when nothing displayed has
// actually changed since the last call (docs/plan.md §13.3 P3 — see the
// lastHud* module comment above). Shared by renderFrame() (every rendered
// frame, but usually a no-op) and updateHudMode() (once, right after a mode
// flip, to force a rewrite via the invalidated cache).
function updateHud(): void {
  const game = session.getGame();
  const occupancyPercent = Math.min(100, Math.floor(game.getOccupancy() * 100));
  const stage = session.getStage();
  const score = session.getScore();
  const hi = session.getHighScore();
  const lives = session.getLives();
  const multiplier = session.getMultiplier();
  // TIME: the run's remaining time budget, counting down from
  // GameSession.getTimeLimitTicks() to 0 (docs/plans/2026-08-13-time-limit-
  // mode) — a run-wide countdown, not a per-stage elapsed count.
  const remainingTicks = session.getRemainingTicks();
  const timeStr = formatTicks(remainingTicks);
  // Last-30-seconds warning (docs/plans/2026-08-13-time-limit-mode): tracked
  // as its own boolean, separately from `timeStr === lastHudTime` below,
  // because the crossing tick doesn't always land on a decisecond-bucket
  // boundary (formatTicks() only changes its displayed string once every 6
  // ticks) — without this, the color flip could lag up to 5 ticks behind
  // the instant remainingTicks actually crosses the threshold.
  const timeWarning = remainingTicks <= HUD_TIME_WARNING_TICKS;

  if (
    stage === lastHudStage &&
    score === lastHudScore &&
    hi === lastHudHi &&
    occupancyPercent === lastHudOccupancy &&
    lives === lastHudLives &&
    multiplier === lastHudMultiplier &&
    timeStr === lastHudTime &&
    timeWarning === lastHudTimeWarning
  ) {
    return;
  }
  lastHudStage = stage;
  lastHudScore = score;
  lastHudHi = hi;
  lastHudOccupancy = occupancyPercent;
  lastHudLives = lives;
  lastHudMultiplier = multiplier;
  lastHudTime = timeStr;
  lastHudTimeWarning = timeWarning;

  // Mode prefix (runMode.ts's resolveHudModePrefix()): '' for 'normal'
  // (byte-identical to before seeded-run support existed, including in
  // two-line mode's lines 1-2 — never touched here at all — which the
  // mobile-viewport E2E test asserts stays unclipped), `SEED <n>` for a
  // `?seed=` run.
  const modePrefix = resolveHudModePrefix(runMode, { seededRunSeed });
  // Reset every line's color to its inherited default first (docs/plans/
  // 2026-08-13-time-limit-mode), then apply the warning color only to
  // whichever line actually carries TIME this frame — necessary because a
  // HUD-mode flip (updateHudMode()) can move TIME from hudLine1 to hudLine3
  // (or back) between one write and the next, and a stale inline color left
  // on the line that *used* to carry TIME would otherwise persist.
  hudLine1.style.color = '';
  hudLine3.style.color = '';
  if (hudTwoLineMode) {
    hudLine1.textContent = `STAGE ${stage}  SCORE: ${score}  HI: ${hi}`;
    hudLine2.textContent = `OCCUPANCY: ${occupancyPercent}%  LIVES: ${lives}  x${multiplier}`;
    hudLine3.textContent = `${modePrefix}TIME ${timeStr}`;
    if (timeWarning) hudLine3.style.color = HUD_TIME_WARNING_COLOR;
  } else {
    hudLine1.textContent =
      `${modePrefix}STAGE ${stage}  SCORE: ${score}  HI: ${hi}  TIME ${timeStr}  ` +
      `OCCUPANCY: ${occupancyPercent}%  LIVES: ${lives}  x${multiplier}`;
    if (timeWarning) hudLine1.style.color = HUD_TIME_WARNING_COLOR;
  }
}

// Keeps the canvas's CSS box letterboxed at the fixed 4:3 (CANVAS_WIDTH x
// CANVAS_HEIGHT) aspect ratio inside whatever space is left in #game-root
// once the HUD row above it is accounted for (docs/plan.md §5.3/§12.1) — the
// canvas's internal resolution never changes here, only its on-screen size.
// Re-run on resize/orientation change; #game-root's own flex-computed size
// already accounts for the touch controls' height (docs/plan.md's "縦持ち
// レイアウト: フィールド上部・コントロール下部") without this function
// needing to know whether they're visible.
//
// The HUD row's height is measured directly (rather than assumed as a
// constant) so it stays correct if its font-size clamp() resolves
// differently at a given viewport width, or if the HUD is currently in
// stacked-lines mode (see updateHudMode()); since neither #hud's lines nor
// its line *count* ever depends on the row's own *width* — which this same
// function sets below — a single measure-then-layout pass is sufficient and
// there's no risk of it oscillating (see wouldSingleLineFit()'s doc comment
// for why updateHudMode()'s own mode *decision*, called first below, can't
// oscillate either, despite now itself depending on a *predicted* width).
function fitCanvasToViewport(): void {
  // Resolve the HUD's line mode (and, if it just changed, its DOM content)
  // before measuring hudRow's real height below, so a mode flip's new line
  // count is already reflected in that measurement rather than lagging a
  // frame behind.
  updateHudMode();

  const hudRowHeight = hudRow.offsetHeight;
  const scale = predictCanvasScale(hudRowHeight);
  if (scale <= 0) return;

  const cssWidth = Math.max(1, Math.floor(CANVAS_WIDTH * scale));
  const cssHeight = Math.max(1, Math.floor(CANVAS_HEIGHT * scale));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  // Keep the HUD row exactly as wide as the canvas's on-screen box
  // (docs/plan.md §12.1: "HUDはフィールドと同じ幅・真上に配置").
  hudRow.style.width = `${cssWidth}px`;
}

// Update logic (fixed timestep)
function update(): void {
  const input = keyboard.getInput();
  lastInput = input;

  // Seed lifecycle (docs/plans/2026-08-16-score-ranking task 2's "gameover
  // →titleで新しい盤面を生成するとき"): queues a fresh seed for whenever
  // resetToFreshRun() next runs. Set every tick while 'gameover' (not just
  // once, on the status-change edge) — simplest correct option, since
  // GameSession.setNextSeed() only cares about whichever value is queued at
  // the instant confirm actually triggers the reset; re-queuing a few dozen
  // times while the GAME OVER screen sits idle is cheap. Never touches a
  // 'seeded' (`?seed=`) run, whose fixed seed must keep reproducing the same
  // board on every retry, exactly as before this feature existed.
  const statusBeforeThisTick = session.getStatus();
  if (runMode === 'normal' && statusBeforeThisTick === 'gameover') {
    session.setNextSeed(generateNormalRunSeed());
  }

  session.update(input);

  // InputRecorder (docs/plans/2026-08-16-score-ranking task 2): reset the
  // instant a fresh run actually starts (gameover -> title, i.e.
  // resetToFreshRun() just fired inside the update() call above) — without
  // this, the recorder's own "have we already seen this totalTicks value"
  // guard would silently refuse to record the new run's early ticks (their
  // totalTicks values are smaller than the previous run's final one).
  // observe() itself is always safe to call unconditionally afterward: it's
  // a no-op on any tick that didn't actually advance a *new* playing tick
  // (title/stageclear/gameover ticks, or this same reset tick).
  if (statusBeforeThisTick === 'gameover' && session.getStatus() === 'title') {
    inputRecorder.reset();
  }
  inputRecorder.observe(session, input);

  sfx.handleEvents(session.drainEvents());
  // Ember despawn vanish effect (docs/plan.md §6 M11 / §12.6): drained at
  // tick granularity, same as the events above, so an effect is queued for
  // every despawn even if several ticks elapse before the next rendered
  // frame actually draws it.
  for (const position of session.drainDespawnedEmberPositions()) {
    renderer.spawnEmberDespawnEffect(position);
  }

  // Persistence: only a 'normal' run may write qixxx.highScore (runMode.ts's
  // shouldPersistHighScore()) — a 'seeded' run still *reads* it for display
  // (see updateHud()'s `hi` value), just never persists to it, since its
  // board isn't the standard one. Skips the write entirely while any debug
  // override is active, mirroring the pre-existing highscore guard
  // (docs/plan.md §6 M10: "デバッグパネル使用中はハイスコアを保存しない").
  if (shouldPersistHighScore(runMode)) {
    const currentHighScore = session.getHighScore();
    if (currentHighScore > lastSavedHighScore && !session.hasActiveDebugOverrides()) {
      lastSavedHighScore = currentHighScore;
      saveHighScore(currentHighScore);
    }
  }
}

// Render the current game state, including the HUD and any Title/StageClear/GameOver screen.
function renderFrame(): void {
  const game = session.getGame();
  const graceTicks = game.getGraceTicks();
  // Miss feedback (docs/plan.md §6 M5): blink the marker off every other
  // MISS_BLINK_INTERVAL_TICKS-tick window for as long as the post-miss grace
  // period lasts; otherwise always visible.
  const markerVisible = graceTicks <= 0 || Math.floor(graceTicks / MISS_BLINK_INTERVAL_TICKS) % 2 === 0;

  renderer.render(
    game.getField(),
    game.getMarker().getPosition(),
    game.getWisps().map((wisp) => wisp.getTrailRef()),
    game.getEmbers(),
    game.getIgniterPosition(),
    markerVisible
  );

  // Continuous line-drawing drone (docs/plan.md §3.8): driven off the
  // marker's actual drawing state plus whichever speed button the most
  // recent tick's merged input held.
  sfx.setDrawing(game.getMarker().isDrawing(), game.getMarker().isDrawing() ? (lastInput.slow ? 'slow' : 'fast') : null);

  updateHud();

  const status = session.getStatus();

  // GAME OVER modal edge trigger (docs/plan-cloudflare-x-share.md Phase 1):
  // show it exactly once on the frame `status` first becomes 'gameover',
  // hide it exactly once when it stops being 'gameover' (e.g. "BACK TO
  // TITLE"/any-key resets the run to 'title'). Re-read here (rather than
  // reused from updateHud()'s internals) since that call may have skipped
  // its own re-read via the lastHud* cache when nothing displayed changed.
  if (status === 'gameover') {
    if (!gameOverModalShown) {
      gameOverModalShown = true;
      gameOverModal.show({
        score: session.getScore(),
        stage: session.getStage(),
        hiScore: session.getHighScore(),
        // TIME UP! (docs/plans/2026-08-13-time-limit-mode): distinguishes a
        // time-budget-expired gameover from an ordinary life-loss one — see
        // GameSession.getGameOverReason()'s doc comment for the two causes.
        reason: session.getGameOverReason() ?? undefined,
      });
    }
  } else if (gameOverModalShown) {
    gameOverModalShown = false;
    gameOverModal.hide();
  }

  if (status === 'playing') {
    // Skip building the (empty) string entirely while playing (docs/plan.md
    // §13.3 P3) — screenText()'s 'playing' branch always returns ''.
    if (lastScreenText !== '') {
      lastScreenText = '';
      screen.textContent = '';
    }
  } else {
    const text = screenText(status);
    if (text !== lastScreenText) {
      lastScreenText = text;
      screen.textContent = text;
    }
  }
}

function screenText(status: ReturnType<GameSession['getStatus']>): string {
  switch (status) {
    case 'title':
      return `QIXXX\n\nHI SCORE: ${session.getHighScore()}\n\nPRESS ANY KEY OR TAP TO START`;
    case 'stageclear': {
      const splitNote = session.getGame().getLastClearWasSplit() ? '\n(SPLIT CLEAR!)' : '';
      return `STAGE ${session.getStage()} CLEAR!${splitNote}\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE`;
    }
    case 'gameover':
      // Score info + the "press any key" hint both live inside the
      // GameOverModal now (docs/plan-cloudflare-x-share.md Phase 1) — it's
      // an opaque box centered at this exact same spot, so leaving text here
      // too would just sit invisibly behind it. Returning '' avoids that
      // dead/duplicate node entirely (see the module comment in
      // src/ui/gameOverModal.ts's hint line).
      return '';
    case 'playing':
      return '';
  }
}

// Game loop with fixed timestep (accumulator pattern)
function gameLoop(currentTime: number): void {
  // Clamp delta so returning from an inactive tab doesn't trigger
  // thousands of catch-up updates (spiral of death)
  const deltaTime = Math.min((currentTime - lastTime) / 1000, MAX_FRAME_DELTA);
  lastTime = currentTime;

  // Accumulate time and run fixed updates
  accumulator += deltaTime;
  while (accumulator >= TICK_DURATION) {
    update();
    accumulator -= TICK_DURATION;
  }

  // Render
  renderFrame();

  // Continue loop
  requestAnimationFrame(gameLoop);
}

// Start game
window.addEventListener('DOMContentLoaded', () => {
  init();
  requestAnimationFrame(gameLoop);
});
