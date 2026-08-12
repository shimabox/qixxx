import { GameSession, SessionInput, SessionStatus } from './core/session';
import { Renderer } from './render/renderer';
import { KeyboardInput } from './input/keyboard';
import { TouchControls, attachTapToConfirm } from './input/touch';
import { SfxEngine } from './audio/sfx';
import { hashString } from './core/rng';
import { loadHighScore, saveHighScore } from './storage/highscore';
import { loadMuted, saveMuted } from './storage/settings';
import { loadBestTime, saveBestTimeIfBetter } from './storage/bestTimes';
import { getJstDateString, loadDailyBest, saveDailyBestIfBetter, cleanupOldDailyKeys } from './storage/daily';
import {
  RunMode,
  shouldPersistHighScore,
  shouldPersistDailyBest,
  shouldPersistBestTime,
  resolveTitleConfirmRunMode,
  resolveDisplayHighScore,
  resolveHudModePrefix,
} from './runMode';
import { initGameOverModal, GameOverModal } from './ui/gameOverModal';
// Type-only: erased at compile time, so this never pulls src/debug/panel.ts
// itself (dev-only, dynamically `import()`ed below) into the production
// bundle — see that module's own "no debug code in dist/" comment.
import type { DebugPanelHandle } from './debug/panel';
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
  HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX,
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
    row.style.gap = '8px';
    row.style.boxSizing = 'border-box';
    root.appendChild(row);
  }
  return row;
}

// Get or create the title-only UI row (DAILY button + best-score label —
// P2 user-review fix, 2026-08-11): a *separate* sibling row from #hud-row,
// not crammed into it. Originally the DAILY button/label lived inside
// #hud-row itself alongside the credit link/MUTE button; on a 390px-wide
// Title screen the four `flex: 0 0 auto` (non-shrinking) items left #hud
// (the STAGE/SCORE/HI/TIME/OCCUPANCY/LIVES text, `flex: 1 1 auto`) squeezed
// down to an unreadable ~9px. Giving the DAILY UI its own row removes that
// competition entirely, at every viewport width — #hud-row's own layout is
// now completely unaffected by whether the DAILY UI exists at all.
//
// Hidden via `display: none` (a second P2 user-review fix, 2026-08-12 — an
// earlier version of this used `visibility: hidden`, which keeps the row
// occupying its box in #game-root's flex column even while hidden: that
// permanently shrank the canvas during ordinary play, e.g. 1280x720's HUD-
// to-canvas gap growing from 6px to ~40px and canvas height shrinking from
// 686px to 652px — a real, unintended change to normal mode's *appearance*,
// not just an "accepted tradeoff"). `display: none` removes it from
// #game-root's flex layout entirely while hidden, so ordinary play is
// byte-for-byte the pre-DAILY-feature layout again. The cost: main.ts's
// updateDailyUiVisibility() must now call fitCanvasToViewport() itself
// right after toggling this row's display, so the canvas/HUD row resize to
// match immediately on every Title <-> Playing transition instead of
// staying stale until the next resize/orientationchange.
function getTitleUiRowElement(root: HTMLDivElement): HTMLDivElement {
  let row = document.getElementById('title-ui-row') as HTMLDivElement | null;
  if (!row) {
    row = document.createElement('div');
    row.id = 'title-ui-row';
    row.style.display = 'none';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'flex-start';
    row.style.gap = '8px';
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
  }
  return button;
}

// Get or create the DAILY button (docs/plans/2026-08-11-daily-seed-time-
// attack request task 4): same button-styling approach as
// getMuteButtonElement() above (pointer-events: auto, a plain click
// listener — no synthetic keyboard events, so clicking it can never also
// feed the keyboard/touch `confirm` pulse), but mounted into #title-ui-row
// (see getTitleUiRowElement()'s doc comment), not #hud-row itself — shown
// only while the Title screen is up (renderFrame()'s
// updateDailyUiVisibility()) so it never crowds the HUD during actual play.
function getDailyButtonElement(row: HTMLDivElement, onClick: () => void): HTMLButtonElement {
  let button = document.getElementById('daily-button') as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = 'daily-button';
    button.type = 'button';
    button.textContent = 'DAILY';
    button.style.flex = '0 0 auto';
    button.style.font = HUD_FONT;
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.padding = '4px 10px';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    button.addEventListener('click', onClick);
    row.appendChild(button);
  }
  return button;
}

// Get or create the small label next to the DAILY button showing today's
// date and the current DAILY best score (docs/plans/2026-08-11-daily-seed-
// time-attack request task 4: "タイトルの DAILY ボタン付近にデイリーベスト
// スコアを表示する") — shown/hidden alongside the button itself.
function getDailyBestLabelElement(row: HTMLDivElement): HTMLDivElement {
  let label = document.getElementById('daily-best-label') as HTMLDivElement | null;
  if (!label) {
    label = document.createElement('div');
    label.id = 'daily-best-label';
    label.style.flex = '0 0 auto';
    label.style.font = HUD_FONT;
    label.style.fontSize = '0.8em';
    label.style.color = HUD_TEXT_COLOR;
    label.style.whiteSpace = 'nowrap';
    label.style.pointerEvents = 'none';
    label.style.userSelect = 'none';
    row.appendChild(label);
  }
  return label;
}

// Game state
let session: GameSession;
let renderer: Renderer;
let keyboard: KeyboardInput;
let sfx: SfxEngine;
let hud: HTMLDivElement;
let hudLine1: HTMLDivElement;
let hudLine2: HTMLDivElement;
// Narrow-viewport-only 3rd line (P2 user-review fix, 2026-08-11): TIME (and
// the DAILY/SEED mode prefix) got its own line rather than fighting
// STAGE/SCORE/HI (line 1) or OCCUPANCY/LIVES (line 2) for width — both of
// those were already at/near their character budget at 390px *before* TIME
// was added, so adding it to either risked silently overflowing past the
// existing E2E-guarded OCCUPANCY/LIVES text (or, on line 1, TIME's own
// text). Shown/hidden together with hudLine2 — see updateHudMode().
let hudLine3: HTMLDivElement;
let screen: HTMLDivElement;
let gameOverModal: GameOverModal;
let muteButton: HTMLButtonElement;
let gameRoot: HTMLDivElement;
let hudRow: HTMLDivElement;
// Title-only DAILY button/label row (P2 user-review fix, 2026-08-11) — see
// getTitleUiRowElement()'s doc comment.
let titleUiRow: HTMLDivElement;
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
// TIME (docs/plans/2026-08-11-daily-seed-time-attack request task 4) changes
// far more often than the fields above (roughly every 6 ticks, a decisecond
// at TICK_RATE=60) — cached as a string (not raw ticks) so the comparison
// above stays a single strict-equality check per field, same shape as every
// other lastHud* cache.
let lastHudTime = '';
// Cache-busts the whole updateHud() comparison the instant `runMode` itself
// flips (e.g. a DAILY/seeded run's HUD text gaining/losing its mode
// prefix) even if every other displayed value happens to be unchanged that
// same tick.
let lastHudRunMode: RunMode = 'normal';

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

// Set once the dev-only debug panel's dynamic import resolves (see init()'s
// `?debug` branch below) — `undefined` for the entire lifetime of a
// production build/non-`?debug` session, in which case every
// `debugPanelHandle?.refresh()` call below is a harmless no-op. See
// src/debug/panel.ts's DebugPanelHandle/initDebugPanel doc comments for the
// P2 user-review fix (2026-08-11) this exists for: without re-syncing the
// panel's displayed slider values after a session swap, they'd keep
// showing the just-discarded session's last values.
let debugPanelHandle: DebugPanelHandle | undefined;

// DAILY / TIME ATTACK / SEEDED RUNS (docs/plans/2026-08-11-daily-seed-time-
// attack request tasks 2-4, refined by the 2026-08-11 cross-review fix).
// `explicitSeedParam` is read once at init() from `?seed=`; when present it
// takes priority *as the seed value* whenever a DAILY run starts (request
// task 4: "?seed と DAILY ボタンが両方関与する場合は明示的な ?seed を優先
// する") — but merely loading the page with `?seed=` and pressing a normal
// key/tap (not the DAILY button) is its own distinct 'seeded' RunMode, not
// 'daily' (see runMode.ts's module comment: an arbitrary seed must never be
// able to write qixxx.daily.<date>.best or claim the "DAILY <date>" HUD
// label — that was the cross-review's actual finding).
let explicitSeedParam: number | undefined;
let dailyBestLabel: HTMLDivElement;
// See runMode.ts's RunMode doc comment for exactly what each value gates
// (qixxx.highScore / qixxx.daily.<date>.best / qixxx.bestTimes read-write,
// HUD prefix). Reset by startNormalRunSession()/startSeededRunSession()/
// startDailyRunSession(); never reset by the session's own internal
// GameOver -> Title transition on its own — see maybeStartFreshRunFromTitle()
// for the (runMode.ts-driven) logic deciding what a later Title-screen
// confirm should do.
let runMode: RunMode = 'normal';
let dailyDateStr = '';
// The seed value used by the current 'seeded' (non-daily) run, shown as
// `SEED <n>` in the HUD (runMode.ts's resolveHudModePrefix()) so it's never
// mistaken for the real DAILY board. Unused (and left stale, harmlessly)
// outside runMode === 'seeded'.
let seededRunSeed: number | undefined;
// The DAILY best score already on record when the *current* DAILY run
// started — used both to compute the displayed "HI" (getDisplayHighScore())
// and as the baseline lastSavedDailyBest starts from. Unused outside
// runMode === 'daily'.
let dailyBestAtRunStart = 0;
// Mirrors lastSavedHighScore's write-on-change-only guard, but for the
// separate qixxx.daily.<date>.best key (never qixxx.highScore) while
// runMode === 'daily'.
let lastSavedDailyBest = 0;
// Whether the DAILY button/best-label pair is currently shown (Title screen
// only) — toggled in renderFrame(), mirroring gameOverModalShown's
// edge-trigger-on-status-change pattern below.
let dailyUiVisible = false;
let lastDailyBestLabelText = '';

// StageClear TIME/BEST/NEW RECORD (docs/plans/2026-08-11-daily-seed-time-
// attack request task 4). Populated once, edge-triggered on the tick the
// session's status first becomes 'stageclear' (see `prevStatus` below,
// mirroring gameOverModalShown's own edge-trigger) — screenText() then just
// reads these cached strings every frame instead of re-formatting/re-saving
// on every render.
let stageClearTimeStr = '';
let stageClearBestStr = '';
let stageClearIsNewRecord = false;
// False for a DAILY run (the board isn't the normal one, so a "best" isn't
// meaningful — request task 4: "通常モードのみベストタイムを記録する") —
// screenText() omits the "/ BEST ..." suffix entirely when this is false.
let stageClearShowsBest = false;
// Tracks the previous tick's session status purely to edge-detect the
// title/playing/stageclear/gameover transitions above (getStatus() itself
// has no "did it just change" signal of its own).
let prevStatus: SessionStatus = 'title';

// DAILY / TIME ATTACK helpers (docs/plans/2026-08-11-daily-seed-time-attack
// request tasks 2-4).

/** Parses `?seed=<number>` from the page URL, or `undefined` if absent/not a finite number. */
function parseSeedParam(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/**
 * The seed + JST date string a DAILY/`?seed=` run should use right now.
 * `explicitSeedParam` (an explicit `?seed=`) always wins over the date-
 * derived seed when both are in play (request task 4: "?seed と DAILY ボタ
 * ンが両方関与する場合は明示的な ?seed を優先する") — the date itself is
 * still always today's, since the DAILY label/best-score bucket reuses the
 * same per-date route regardless of which seed produced the board.
 */
function getEffectiveDailySeed(): { seed: number; dateStr: string } {
  const dateStr = getJstDateString();
  const seed = explicitSeedParam ?? hashString(`qixxx-daily-${dateStr}`);
  return { seed, dateStr };
}

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

/**
 * The "HI"/"HI SCORE" value to display right now — delegates to
 * runMode.ts's resolveDisplayHighScore() (see its doc comment): 'daily'
 * shows the DAILY best (never mixing in qixxx.highScore), 'normal' and
 * 'seeded' both show the session's own ordinary high score (read-only for
 * 'seeded' — the write is separately suppressed in update() below).
 */
function getDisplayHighScore(): number {
  return resolveDisplayHighScore(runMode, {
    dailyBestAtRunStart,
    currentScore: session.getScore(),
    sessionHighScore: session.getHighScore(),
  });
}

/**
 * Resets every per-run render/state cache so a freshly-swapped `session`
 * starts painting from a clean slate. Also re-syncs the debug panel's
 * displayed slider values to the new session (P2 user-review fix,
 * 2026-08-11 — see debugPanelHandle's doc comment): every
 * startNormalRunSession()/startSeededRunSession()/startDailyRunSession()
 * call site swaps `session` and then immediately calls this, so this is
 * the one shared place a refresh can never be forgotten.
 */
function resetPerRunCaches(): void {
  lastHudStage = -1;
  lastHudScore = -1;
  lastHudHi = -1;
  lastHudOccupancy = -1;
  lastHudLives = -1;
  lastHudMultiplier = -1;
  lastHudTime = '';
  lastHudRunMode = 'normal';
  lastScreenText = null;
  gameOverModalShown = false;
  stageClearTimeStr = '';
  stageClearBestStr = '';
  stageClearIsNewRecord = false;
  stageClearShowsBest = false;
  prevStatus = 'title';
  debugPanelHandle?.refresh();
}

/** Swaps `session` for a brand-new, unseeded (ordinary) run — see maybeStartFreshRunFromTitle()'s call site. */
function startNormalRunSession(): void {
  runMode = 'normal';
  dailyDateStr = '';
  seededRunSeed = undefined;
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  session = new GameSession({ highScore });
  window.__game__ = { session, sfx };
  resetPerRunCaches();
}

/**
 * Swaps `session` for a brand-new run seeded with `seed`, WITHOUT treating
 * it as DAILY (2026-08-11 cross-review fix): a page load with `?seed=`
 * started by a normal key/tap, or a Title-screen fallback from a previous
 * DAILY run — see maybeStartFreshRunFromTitle() and runMode.ts's module
 * comment for why this must stay entirely separate from
 * startDailyRunSession() below. Reads (for display) but never writes
 * qixxx.highScore — the write is suppressed in update() via
 * shouldPersistHighScore(runMode).
 */
function startSeededRunSession(seed: number): void {
  runMode = 'seeded';
  seededRunSeed = seed;
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  session = new GameSession({ seed, highScore });
  window.__game__ = { session, sfx };
  resetPerRunCaches();
}

/**
 * Swaps `session` for a brand-new, genuine DAILY run — only ever called
 * from onDailyButtonClick() below (2026-08-11 cross-review fix: merely
 * loading `?seed=` is NOT enough to be 'daily' — see startSeededRunSession()
 * and runMode.ts's module comment). Never reads/writes qixxx.highScore
 * (request.md task 4: "デイリーモード中は通常ハイスコアを読み書きしない");
 * reads/writes qixxx.daily.<dateStr>.best instead (see update()).
 */
function startDailyRunSession(seed: number, dateStr: string): void {
  runMode = 'daily';
  dailyDateStr = dateStr;
  seededRunSeed = undefined;
  dailyBestAtRunStart = loadDailyBest(dateStr);
  lastSavedDailyBest = dailyBestAtRunStart;
  session = new GameSession({ seed });
  window.__game__ = { session, sfx };
  resetPerRunCaches();
}

/**
 * DAILY button click handler (request task 4: "クリック/タップでデイリー
 * モードのランを開始する"). A plain click listener — no synthetic keyboard
 * event is ever dispatched here (unlike input/touch.ts's virtual d-pad), so
 * this can never also feed the keyboard/touch `confirm` pulse. Feeds a
 * single manual `confirm` into the freshly-swapped session immediately
 * after constructing it, starting play on the very same click rather than
 * waiting for a separate key/tap. Always produces a genuine 'daily' run
 * (never 'seeded') — see startDailyRunSession()'s doc comment.
 */
function onDailyButtonClick(): void {
  const { seed, dateStr } = getEffectiveDailySeed();
  startDailyRunSession(seed, dateStr);
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
}

/**
 * A normal key/tap confirming a Title screen decides the resulting run's
 * mode via runMode.ts's resolveTitleConfirmRunMode() (see its doc comment
 * for the full decision table) — only swaps `session` when that decision
 * actually differs from the currently-active mode:
 * - 'normal' or 'seeded' currently active: no-op (GameSession's own
 *   internal reset already reuses the same seed, or lack thereof, across
 *   every retry).
 * - 'daily' currently active: swaps to a fresh 'seeded' run (if `?seed=`
 *   pinned the page load) or a fresh 'normal' run (otherwise) — only the
 *   DAILY button (onDailyButtonClick above) may start another 'daily' run
 *   from Title.
 * A no-op whenever `session` isn't sitting on Title with a fresh confirm
 * (i.e. every ordinary tick) — including the very first Title screen ever
 * (runMode is 'normal' by default), so normal mode's existing behavior is
 * completely untouched.
 */
function maybeStartFreshRunFromTitle(input: SessionInput): void {
  if (session.getStatus() !== 'title' || !input.confirm) return;
  const nextMode = resolveTitleConfirmRunMode(runMode, explicitSeedParam);
  if (nextMode === runMode) return;
  // resolveTitleConfirmRunMode() only ever returns 'seeded' when
  // explicitSeedParam is defined — the `!== undefined` check here is just
  // how TypeScript sees that correlation (not an independent runtime case).
  if (nextMode === 'seeded' && explicitSeedParam !== undefined) {
    startSeededRunSession(explicitSeedParam);
  } else {
    startNormalRunSession();
  }
}

/**
 * Shows/hides #title-ui-row (the DAILY button + best-score label — Title
 * screen only) and keeps the label's text current (today's date + today's
 * DAILY best, refreshed on every Title-screen frame in case another tab/
 * session just updated it — cheap: a small string comparison gates the
 * actual DOM write, same pattern as every other cached HUD field). Toggles
 * `display` (not `visibility`) on the row itself — see
 * getTitleUiRowElement()'s doc comment for why — which means an actual
 * Title <-> Playing transition changes #game-root's flex layout (the row
 * is added/removed from flow entirely), so fitCanvasToViewport() is
 * re-run right here, on the spot, rather than staying stale until the
 * next resize/orientationchange.
 */
function updateDailyUiVisibility(status: SessionStatus): void {
  const showDailyUi = status === 'title';
  if (showDailyUi !== dailyUiVisible) {
    dailyUiVisible = showDailyUi;
    titleUiRow.style.display = showDailyUi ? 'flex' : 'none';
    fitCanvasToViewport();
  }
  if (!showDailyUi) return;

  const todayStr = getJstDateString();
  const best = loadDailyBest(todayStr);
  const labelText = `DAILY ${todayStr}  BEST ${best}`;
  if (labelText !== lastDailyBestLabelText) {
    lastDailyBestLabelText = labelText;
    dailyBestLabel.textContent = labelText;
  }
}

// Initialize game. init() runs exactly once on page load. All registered
// event listeners and input controllers (TouchControls, KeyboardInput) live
// for the page's lifetime and are intentionally not disposed — this is not
// an SPA embedded context but a full-page app. Should remounting become
// necessary in the future, design and call explicit dispose() methods then.
function init(): void {
  // Startup cleanup (docs/plans/2026-08-11-daily-seed-time-attack request
  // task 3): reclaim every past date's DAILY best-score key, best-effort.
  cleanupOldDailyKeys(getJstDateString());

  explicitSeedParam = parseSeedParam();
  if (explicitSeedParam !== undefined) {
    // `?seed=` pins the whole page load to a 'seeded' run (NOT 'daily' —
    // 2026-08-11 cross-review fix, see runMode.ts's module comment) from
    // the very first Title screen. maybeStartFreshRunFromTitle() keeps
    // reusing this seed for every retry (GameOver -> Title -> Playing)
    // without ever falling back to an unseeded run for the rest of this
    // page load.
    runMode = 'seeded';
    seededRunSeed = explicitSeedParam;
    const highScore = loadHighScore();
    lastSavedHighScore = highScore;
    session = new GameSession({ seed: explicitSeedParam, highScore });
  } else {
    const highScore = loadHighScore();
    lastSavedHighScore = highScore;
    session = new GameSession({ highScore });
  }

  gameRoot = getGameRootElement();
  hudRow = getHudRowElement(gameRoot);
  titleUiRow = getTitleUiRowElement(gameRoot);
  const canvasWrap = getCanvasWrapElement(gameRoot);
  canvas = getCanvasElement(canvasWrap);
  renderer = new Renderer(canvas);
  keyboard = new KeyboardInput();
  // Touch controls dispatch synthetic KeyboardEvents on `window` (their
  // default target), exactly matching KeyboardInput's own listening target
  // above — see input/touch.ts's module comment for why that's a complete
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
  hudTwoLineMode = window.innerWidth <= HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX;
  hudLine2.style.display = hudTwoLineMode ? 'block' : 'none';
  hudLine3.style.display = hudTwoLineMode ? 'block' : 'none';
  screen = getScreenElement(canvasWrap);
  gameOverModal = initGameOverModal(canvasWrap);

  sfx = new SfxEngine(loadMuted());
  // DAILY button + best-score label (docs/plans/2026-08-11-daily-seed-time-
  // attack request task 4) live in their own #title-ui-row, not #hud-row
  // (P2 user-review fix, 2026-08-11 — see getTitleUiRowElement()'s doc
  // comment for why). Reads left-to-right as [DAILY <date> BEST N] [DAILY
  // button]. Hidden (`display: none`, dropped from flow entirely) outside
  // the Title screen — see updateDailyUiVisibility(), called every
  // renderFrame().
  dailyBestLabel = getDailyBestLabelElement(titleUiRow);
  getDailyButtonElement(titleUiRow, onDailyButtonClick);
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
  //
  // Passes a `() => session` *getter* (P2 user-review fix, 2026-08-11), not
  // `session` itself — DAILY/seeded/normal-restart runs swap the module-
  // level `session` variable out for a brand-new GameSession (see
  // startNormalRunSession()/startSeededRunSession()/startDailyRunSession()
  // above), and src/debug/panel.ts's own doc comment explains why a plain
  // instance reference would silently keep operating on a discarded
  // session forever after that. The returned handle's refresh() is called
  // from every one of those swap points so the panel's *displayed* slider
  // values also catch up to the new session immediately.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('debug')) {
    void import('./debug/panel').then(({ initDebugPanel }) => {
      debugPanelHandle = initDebugPanel(() => session, hudRow);
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

// Re-derive the HUD's line mode from window.innerWidth alone (never from
// hudRow/canvas width — see HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX's comment in
// config.ts for why that would be circular). Called from fitCanvasToViewport()
// itself, which already runs on init + every resize/orientationchange, so no
// separate listener is needed. On an actual mode flip, invalidates the
// lastHud* cache (so the next updateHud() call unconditionally rewrites the
// DOM into the new line layout instead of skipping a no-op-looking value
// comparison) and immediately reflects the new mode into the DOM/cache via
// updateHud(), so hudRow's height already accounts for it by the time
// fitCanvasToViewport() measures hudRow.offsetHeight right after this call.
function updateHudMode(): void {
  const twoLine = window.innerWidth <= HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX;
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
  const hi = getDisplayHighScore();
  const lives = session.getLives();
  const multiplier = session.getMultiplier();
  // TIME (docs/plans/2026-08-11-daily-seed-time-attack request task 4): the
  // *current stage's* elapsed tick count — matches what qixxx.bestTimes
  // records per stage (see handleStageClearEntered()), not the run total.
  const timeStr = formatTicks(session.getStageTicks());

  if (
    stage === lastHudStage &&
    score === lastHudScore &&
    hi === lastHudHi &&
    occupancyPercent === lastHudOccupancy &&
    lives === lastHudLives &&
    multiplier === lastHudMultiplier &&
    timeStr === lastHudTime &&
    runMode === lastHudRunMode
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
  lastHudRunMode = runMode;

  // Mode prefix (runMode.ts's resolveHudModePrefix()): '' for 'normal'
  // (byte-identical to before this feature existed, including in two-line
  // mode's lines 1-2 — never touched here at all — which the mobile-
  // viewport E2E test asserts stays unclipped), `DAILY <date>` for a
  // genuine DAILY run, `SEED <n>` for an arbitrary `?seed=` run (2026-08-11
  // cross-review fix: never `DAILY <date>` for the latter — that was the
  // mislabeling).
  const modePrefix = resolveHudModePrefix(runMode, { dailyDateStr, seededRunSeed });
  if (hudTwoLineMode) {
    // Lines 1-2 are exactly the pre-TIME-attack-feature text (P2 user-
    // review fix, 2026-08-11: both were already at/near their 390px
    // character budget without TIME — see hudLine3's own doc comment); TIME
    // (and the mode prefix, when present) gets its own 3rd line instead of
    // fighting either of them for width.
    hudLine1.textContent = `STAGE ${stage}  SCORE: ${score}  HI: ${hi}`;
    hudLine2.textContent = `OCCUPANCY: ${occupancyPercent}%  LIVES: ${lives}  x${multiplier}`;
    hudLine3.textContent = `${modePrefix}TIME ${timeStr}`;
  } else {
    hudLine1.textContent =
      `${modePrefix}STAGE ${stage}  SCORE: ${score}  HI: ${hi}  TIME ${timeStr}  ` +
      `OCCUPANCY: ${occupancyPercent}%  LIVES: ${lives}  x${multiplier}`;
  }
}

// Keeps the canvas's CSS box letterboxed at the fixed 4:3 (CANVAS_WIDTH x
// CANVAS_HEIGHT) aspect ratio inside whatever space is left in #game-root
// once the HUD row — and #title-ui-row, only while it's actually in flow
// (Title screen only, see below) — above it are accounted for (docs/plan.md
// §5.3/§12.1) — the canvas's internal resolution never changes here, only
// its on-screen size. Re-run on resize/orientation change (and, since
// #title-ui-row toggles via `display` — see getTitleUiRowElement()'s doc
// comment — every Title <-> Playing transition too, from
// updateDailyUiVisibility()); #game-root's own flex-computed size already
// accounts for the touch controls' height (docs/plan.md's "縦持ちレイアウ
// ト: フィールド上部・コントロール下部") without this function needing to
// know whether they're visible.
//
// Both rows' heights are measured directly (rather than assumed as
// constants) so they stay correct if font-size clamp()/content resolves
// differently at a given viewport width, or if the HUD is currently in
// two-line mode (see updateHudMode()); since neither row's height ever
// depends on its own *width* — which this same function sets below — a
// single measure-then-layout pass is sufficient and there's no risk of it
// oscillating.
function fitCanvasToViewport(): void {
  // Resolve the HUD's line mode (and, if it just changed, its DOM content)
  // from window.innerWidth *before* measuring hudRow's height below, so a
  // mode flip's new line count is already reflected in that measurement
  // rather than lagging a frame behind.
  updateHudMode();

  const availW = gameRoot.clientWidth;
  const hudRowHeight = hudRow.offsetHeight;
  // 0 while #title-ui-row is `display: none` (every status except Title —
  // see getTitleUiRowElement()'s doc comment for why `display`, not
  // `visibility`, is used: this must genuinely drop out of #game-root's
  // flex layout during ordinary play, restoring the exact pre-DAILY-feature
  // HUD-to-canvas gap/canvas size).
  const titleUiRowHeight = titleUiRow.offsetHeight;
  // #game-root's flex `gap` only applies between children actually in flow
  // — a `display: none` child contributes neither height nor a gap. 2 gaps
  // (hudRow<->titleUiRow, titleUiRow<->canvasWrap) when #title-ui-row is
  // showing, else the original single gap (hudRow<->canvasWrap).
  const gapCount = titleUiRowHeight > 0 ? 2 : 1;
  const availH = gameRoot.clientHeight - hudRowHeight - titleUiRowHeight - HUD_GAP_PX * gapCount;
  if (availW <= 0 || availH <= 0) return;

  const scale = Math.min(availW / CANVAS_WIDTH, availH / CANVAS_HEIGHT);
  const cssWidth = Math.max(1, Math.floor(CANVAS_WIDTH * scale));
  const cssHeight = Math.max(1, Math.floor(CANVAS_HEIGHT * scale));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  // Keep both rows exactly as wide as the canvas's on-screen box
  // (docs/plan.md §12.1: "HUDはフィールドと同じ幅・真上に配置").
  hudRow.style.width = `${cssWidth}px`;
  titleUiRow.style.width = `${cssWidth}px`;
}

// Update logic (fixed timestep)
function update(): void {
  const input = keyboard.getInput();
  lastInput = input;

  // DAILY/SEEDED (docs/plans/2026-08-11-daily-seed-time-attack request task
  // 4, refined by the 2026-08-11 cross-review fix): a normal key/tap from a
  // Title screen still tied to a previous DAILY run may swap `session` out
  // for a fresh 'seeded' or 'normal' one — see its doc comment. Must run
  // before session.update(input) below so this same tick's confirm still
  // drives the (possibly new) session's own Title -> Playing transition,
  // not the next one.
  maybeStartFreshRunFromTitle(input);

  session.update(input);
  sfx.handleEvents(session.drainEvents());
  // Ember despawn vanish effect (docs/plan.md §6 M11 / §12.6): drained at
  // tick granularity, same as the events above, so an effect is queued for
  // every despawn even if several ticks elapse before the next rendered
  // frame actually draws it.
  for (const position of session.drainDespawnedEmberPositions()) {
    renderer.spawnEmberDespawnEffect(position);
  }

  // StageClear TIME/BEST/NEW RECORD (docs/plans/2026-08-11-daily-seed-time-
  // attack request task 4): edge-triggered exactly once, the tick status
  // first becomes 'stageclear', so the recorded/displayed values stay fixed
  // for as long as the StageClear screen is up (not re-evaluated every tick
  // — getStageTicks() is frozen anyway once the stage leaves 'playing', but
  // saveBestTimeIfBetter() itself must run only once per clear).
  const status = session.getStatus();
  if (status === 'stageclear' && prevStatus !== 'stageclear') {
    handleStageClearEntered();
  }
  prevStatus = status;

  // Persistence, gated per runMode.ts's shouldPersist*() (2026-08-11
  // cross-review fix): only a genuine DAILY run (runMode === 'daily') may
  // write qixxx.daily.<date>.best — an arbitrary 'seeded' run must never be
  // able to overwrite today's real DAILY record. Only a 'normal' run may
  // write qixxx.highScore — 'seeded' still *reads* it for display (see
  // getDisplayHighScore()), just never persists to it, since its board
  // isn't the standard one. Every write additionally skips while any debug
  // override is active, mirroring the pre-existing highscore guard
  // (docs/plan.md §6 M10: "デバッグパネル使用中はハイスコアを保存しない").
  if (shouldPersistDailyBest(runMode)) {
    const currentScore = session.getScore();
    if (currentScore > lastSavedDailyBest && !session.hasActiveDebugOverrides()) {
      lastSavedDailyBest = currentScore;
      saveDailyBestIfBetter(dailyDateStr, currentScore);
    }
  } else if (shouldPersistHighScore(runMode)) {
    const currentHighScore = session.getHighScore();
    if (currentHighScore > lastSavedHighScore && !session.hasActiveDebugOverrides()) {
      lastSavedHighScore = currentHighScore;
      saveHighScore(currentHighScore);
    }
  }
  // runMode === 'seeded': no persistence at all — its board is neither the
  // normal one nor today's real DAILY one.
}

/**
 * Records (normal mode only — see shouldPersistBestTime()) and formats this
 * stage's just-finished clear time (docs/plans/2026-08-11-daily-seed-time-
 * attack request task 4). Called exactly once per stage clear — see its
 * only call site in update().
 */
function handleStageClearEntered(): void {
  const ticks = session.getStageTicks();
  stageClearTimeStr = formatTicks(ticks);

  // Neither a DAILY nor an arbitrary seeded run records a best time
  // (request task 4: "デイリーは盤面が日替わりのため記録しない" — the same
  // reasoning applies to any non-standard board, per runMode.ts's
  // shouldPersistBestTime()): the board isn't the fixed, comparable one a
  // "best" is meaningful against.
  if (!shouldPersistBestTime(runMode)) {
    stageClearShowsBest = false;
    return;
  }

  stageClearShowsBest = true;
  const stage = session.getStage();
  // Read-but-don't-write while a debug override is active, exactly like the
  // highscore guard above: never taints the persisted record, but a
  // previously-recorded best is still shown.
  const isNewRecord = session.hasActiveDebugOverrides() ? false : saveBestTimeIfBetter(stage, ticks);
  stageClearIsNewRecord = isNewRecord;
  stageClearBestStr = formatTicks(isNewRecord ? ticks : loadBestTime(stage) ?? ticks);
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

  // DAILY button + best-score label (docs/plans/2026-08-11-daily-seed-time-
  // attack request task 4): visible on the Title screen only.
  updateDailyUiVisibility(status);

  // GAME OVER modal edge trigger (docs/plan-cloudflare-x-share.md Phase 1):
  // show it exactly once on the frame `status` first becomes 'gameover',
  // hide it exactly once when it stops being 'gameover' (e.g. "BACK TO
  // TITLE"/any-key resets the run to 'title'). Re-read here (rather than
  // reused from updateHud()'s internals) since that call may have skipped
  // its own re-read via the lastHud* cache when nothing displayed changed.
  if (status === 'gameover') {
    if (!gameOverModalShown) {
      gameOverModalShown = true;
      gameOverModal.show({ score: session.getScore(), stage: session.getStage(), hiScore: getDisplayHighScore() });
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
      return `QIXXX\n\nHI SCORE: ${getDisplayHighScore()}\n\nPRESS ANY KEY OR TAP TO START`;
    case 'stageclear': {
      const splitNote = session.getGame().getLastClearWasSplit() ? '\n(SPLIT CLEAR!)' : '';
      // TIME/BEST/NEW RECORD (docs/plans/2026-08-11-daily-seed-time-attack
      // request task 4): populated once by handleStageClearEntered() the
      // tick this StageClear screen appeared — see its doc comment. DAILY
      // runs never show a BEST (stageClearShowsBest is false there).
      const recordSuffix = stageClearIsNewRecord ? '  NEW RECORD!' : '';
      const timeLine = stageClearShowsBest
        ? `\nTIME ${stageClearTimeStr} / BEST ${stageClearBestStr}${recordSuffix}`
        : `\nTIME ${stageClearTimeStr}`;
      return `STAGE ${session.getStage()} CLEAR!${splitNote}${timeLine}\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE`;
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
