import { GameSession, SessionInput } from './core/session';
import { ReplayEngine } from './core/replayEngine';
import { Renderer } from './render/renderer';
import { KeyboardInput } from './input/keyboard';
import {
  TouchControls,
  attachTapToConfirm,
  isTouchCapableDevice,
  resolveNarrowSideHudFontSize,
  resolveTouchLayout,
} from './input/touch';
import { SfxEngine } from './audio/sfx';
import { loadHighScore, saveHighScore } from './storage/highscore';
import { loadMuted, saveMuted } from './storage/settings';
import { RunMode, shouldPersistHighScore, resolveHudModePrefix } from './runMode';
import { parseSeedParam } from './seedParam';
import { ReplayStageClearHold } from './replayStageClearHold';
import { TimeWarningCueTracker } from './timeWarningCue';
import { stageClearText } from './stageClearText';
import { StageResultTally, StageResultCounter, stageResultScreen } from './stageResult';
import { initGameOverModal, GameOverModal } from './ui/gameOverModal';
import { initRankingUI, RankingUI } from './ui/ranking';
import { FxDirector, FxFrame } from './fx/director';
import { missReasonKey } from './fx/missReason';
import type { MissFeedback } from './core/feedback';
import { fxParams } from './fx/params';
import { HitStop } from './fx/hitStop';
import { applyImpactNotices, beginLiveTick, GameOverConfirmGate, RetryHold } from './fx/liveTick';
import { stepLiveSession, LiveRunTracker } from './retryFlow';
import { ScoreRoll } from './fx/scoreRoll';
import { loadFxFonts } from './render/fxFonts';
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
  RULESET_VERSION,
  REPLAY_FORMAT_VERSION,
  REPLAY_STAGE_CLEAR_HOLD_TICKS,
  COLOR_FX_SPLIT,
  COLOR_FX_NEON_CYAN,
  COLOR_FX_NEON_MAGENTA,
  FX_TEXT_FONT_FAMILY,
  INITIAL_LIVES,
  HUD_MULTIPLIER_BASE_SCALE,
  HUD_MULTIPLIER_EMPHASIS_EXTRA_SCALE,
  HUD_GAUGE_HEIGHT_PX,
  HUD_GAUGE_NEAR_GOAL_POINTS,
  HUD_GAUGE_TRACK_COLOR,
  HUD_GAUGE_FILL_COLOR,
  HUD_GAUGE_NEAR_COLOR,
  HUD_GAUGE_GOAL_COLOR,
  GAMEOVER_MODAL_COMPACT_BELOW_PX,
  GAMEOVER_MODAL_TINY_BELOW_PX,
  TITLE_BUTTONS_COMPACT_BELOW_PX,
  TITLE_TEXT_COMPACT_OFFSET_PX,
} from './config';
import { hudGoalText } from './hudGoal';
import { floorPercent, hudLines, livesText, HUD_SCORE_SLOT, HUD_LIVES_SLOT, MultiplierEmphasis } from './hudText';
import { detectLocale, getLocale, setLocale, t } from './i18n';
import { EMPTY_SCREEN_TEXT, ScreenText, screenTextString, titleScreenText } from './screenText';
import { applySentenceFont, markEnglishOnly } from './ui/sentenceFont';
import { HintDirector, type HintView } from './hints/director';
import { HintSeenStore } from './storage/hints';
import { HintBar } from './ui/hintBar';
import { HowToPlayUI } from './ui/howToPlay';
import { hintArrowDirection, hintMarkShapes, type HintMarkShapes, type ResolvedHintMark } from './render/hintLayer';
import type { Ember } from './core/patrol';
import type { GameEvent } from './core/events';
import type { ClaimFeedback } from './core/feedback';

// Debug hook (docs/plan.md §7.2: "window.__game__...を公開しておくとE2Eが
// 安定する"). Populated once init() runs; only ever read by tests/devtools —
// nothing in src/ reads it back, so it can't create a hidden coupling.
declare global {
  interface Window {
    __game__?: {
      session: GameSession;
      sfx: SfxEngine;
      /** Impact feedback director of the live run (src/fx/director.ts). */
      fx: FxDirector;
      /** The live run's hit stop (src/fx/hitStop.ts). */
      hitStop: HitStop;
      /** Auto-advance transitions around replay skips — see replayAutoAdvanceLog. */
      getReplayAutoAdvanceLog: () => boolean[];
      /** The in-play hint shown now (src/hints/), or null. */
      getHint: () => { id: string; textKey: string; glow: string | null; age: number } | null;
      /** The hint's ring / arrow handed to the renderer for the last frame, or null. */
      getHintMarks: () => HintMarkShapes | null;
      /** Forgets every seen hint (the debug panel's RESET HINTS). */
      resetHints: () => void;
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
// the space above the touch controls in bottom mode or the body grid's
// center column in side mode. Stacked as a column so the HUD row sits
// directly above the canvas; both are centered as a group and the canvas is
// letterboxed inside its wrapper at a fixed 4:3 aspect ratio via
// fitCanvasToViewport() below.
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
// a flex row that always holds the HUD text and, in bottom mode, also holds
// the credit link and MUTE button. Side mode fixes those extras in the
// viewport's top-right corner via #touch-actions-extra. Its width is kept
// exactly in sync with the canvas's on-screen (CSS) width by
// fitCanvasToViewport(), so it always reads as "the same width as, and directly
// above, the field" regardless of viewport shape.
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
// decided explicitly (updateHudMode(), keyed only off the viewport geometry)
// rather than left to the browser's text wrapping, which would depend on
// the row's own *width* — itself derived from this row's height — creating
// a circular width<->height layout dependency between the HUD row and the
// canvas. The font-size clamp below is overridden only by index.html's
// narrow-side rule, whose size depends only on window.innerWidth and the
// touch layout (see updateTouchLayout()).
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
    // Sized to its own longest line: with only
    // `left: 50%`, an absolutely positioned box shrink-wraps to the space
    // LEFT OF the right edge — i.e. half the field — and a line longer than
    // that wrapped at an arbitrary word. max-content sizes it to the text;
    // max-width keeps wrapping as the last-resort fallback for a line wider
    // than the whole field.
    screen.style.width = 'max-content';
    screen.style.maxWidth = '100%';
    screen.style.color = HUD_TEXT_COLOR;
    screen.style.font = HUD_FONT;
    screen.style.textAlign = 'center';
    // pre-wrap, not pre-line: the STAGE CLEAR result's rows line up with
    // runs of spaces (src/stageResult.ts).
    screen.style.whiteSpace = 'pre-wrap';
    screen.style.textShadow = `0 0 10px ${HUD_ACCENT_COLOR}, 0 0 20px ${HUD_ACCENT_COLOR}`;
    screen.style.pointerEvents = 'none';
    screen.style.userSelect = 'none';
    wrap.appendChild(screen);
  }
  return screen;
}

// Get or create the credit link (author attribution). It sits between #hud and
// #mute-button in the HUD row in bottom mode, then moves with the mute button
// into the viewport's fixed top-right corner via #touch-actions-extra in side
// mode. It must keep pointer-events enabled
// because the HUD row itself disables them. Uses a smaller font than the mute
// button for a modest appearance.
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
// をHUDに置く"). It lives at the HUD row's right edge in bottom mode and moves
// into the viewport's fixed top-right corner via #touch-actions-extra in side
// mode. It remains outside #hud itself (which
// has pointer-events: none), so it stays clickable/tappable in both locations.
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

    // Reserve the width of the longer label ("UNMUTE") up front; toggleMute()/updateMuteButtonLabel() below
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
    button.textContent = t('mute.unmute');
    button.style.minWidth = `${button.getBoundingClientRect().width}px`;
  }
  return button;
}

// Get or create the travelling-multiplier element (see `multiplierFly`).
// Fixed-positioned so it can cross from the canvas to the HUD row; moved
// every rendered frame by renderMultiplierFx(). Neon like the canvas
// effects' text: the bundled display face, white, with a cyan and a magenta
// glow (renderMultiplierFx() sets the glow, split apart for its first ticks).
function getMultiplierFlyElement(): HTMLDivElement {
  let el = document.getElementById('fx-multiplier') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'fx-multiplier';
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.display = 'none';
    el.style.font = HUD_FONT;
    el.style.fontFamily = FX_TEXT_FONT_FAMILY;
    el.style.fontWeight = '700';
    el.style.color = '#ffffff';
    el.style.textShadow = multiplierFlyShadow(0);
    el.style.pointerEvents = 'none';
    el.style.userSelect = 'none';
    el.style.whiteSpace = 'nowrap';
    el.style.zIndex = '20';
    document.body.appendChild(el);
  }
  return el;
}

// The travelling multiplier's glow: cyan (6px) and magenta (14px), the cyan
// moved `offsetPx` left and the magenta as far right.
function multiplierFlyShadow(offsetPx: number): string {
  const off = Math.round(offsetPx * 100) / 100;
  return `${-off}px 0px 6px ${COLOR_FX_NEON_CYAN}, ${off}px 0px 14px ${COLOR_FX_NEON_MAGENTA}`;
}

// The HUD's SCORE number, as its own span so it can glow while it counts up
// (see `hudScoreRoll`); the line's text is unchanged by it.
function getHudScoreElement(): HTMLSpanElement {
  let el = document.getElementById('hud-score') as HTMLSpanElement | null;
  if (!el) {
    el = document.createElement('span');
    el.id = 'hud-score';
  }
  return el;
}

// Get or create the occupancy gauge: a HUD_GAUGE_HEIGHT_PX bar as wide as the
// field, absolutely positioned in the HUD_GAP_PX gap just above it (anchored
// to #canvas-wrap, whose box is the field's), so it adds nothing to the
// layout's height. 100% is the field's full width; the goal mark is 2px wide
// and reaches 3px past the bar above and below so it is easy to find on a
// phone, where the bar stays 4px tall.
function getGaugeElements(wrap: HTMLDivElement): { gauge: HTMLDivElement; fill: HTMLDivElement; goal: HTMLDivElement } {
  let gauge = document.getElementById('hud-gauge') as HTMLDivElement | null;
  if (!gauge) {
    gauge = document.createElement('div');
    gauge.id = 'hud-gauge';
    gauge.style.position = 'absolute';
    gauge.style.left = '0';
    gauge.style.right = '0';
    // Centered in the gap: (HUD_GAP_PX - height) / 2 above the field's top edge.
    gauge.style.bottom = `calc(100% + ${(HUD_GAP_PX - HUD_GAUGE_HEIGHT_PX) / 2}px)`;
    gauge.style.height = `${HUD_GAUGE_HEIGHT_PX}px`;
    gauge.style.background = HUD_GAUGE_TRACK_COLOR;
    gauge.style.pointerEvents = 'none';
    gauge.style.userSelect = 'none';

    const fill = document.createElement('div');
    fill.id = 'hud-gauge-fill';
    fill.style.position = 'absolute';
    fill.style.left = '0';
    fill.style.top = '0';
    fill.style.bottom = '0';
    fill.style.width = '0%';
    fill.style.background = HUD_GAUGE_FILL_COLOR;
    gauge.appendChild(fill);

    const goal = document.createElement('div');
    goal.id = 'hud-gauge-goal';
    goal.style.position = 'absolute';
    goal.style.top = '-3px';
    goal.style.bottom = '-3px';
    goal.style.width = '2px';
    goal.style.left = 'calc(0% - 1px)';
    goal.style.background = HUD_GAUGE_GOAL_COLOR;
    gauge.appendChild(goal);

    wrap.appendChild(gauge);
  }
  return {
    gauge,
    fill: document.getElementById('hud-gauge-fill') as HTMLDivElement,
    goal: document.getElementById('hud-gauge-goal') as HTMLDivElement,
  };
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
let rankingUI: RankingUI;
// The Title screen's HOW TO PLAY button and panel (src/ui/howToPlay.ts).
let howToPlay: HowToPlayUI;
let muteButton: HTMLButtonElement;
let creditLink: HTMLAnchorElement;

// REPLAY VIEWING isolates all live-run side effects. While
// `viewMode === 'replay'`, update()/renderFrame()
// branch almost entirely away from the live-run path below — no keyboard
// input reaches core, no highscore persistence, no InputRecorder
// observation, no GAME OVER modal/ranking-submission UI, no sfx. Driven by
// `replayEngine` (src/core/replayEngine.ts) instead of the live `session`;
// renderFrame() simply reads whichever of the two is currently active,
// since both are the same GameSession class with an identical rendering
// -relevant API.
type ViewMode = 'live' | 'replay';
let viewMode: ViewMode = 'live';
let replayEngine: ReplayEngine | null = null;
let replayAutoAdvance = true;
// Test-visibility only (see the onReplayAutoAdvanceChange wiring in init()):
// a capped record of the auto-advance transitions, exposed on window.__game__.
const replayAutoAdvanceLog: boolean[] = [];
// Keeps a cleared stage on screen for REPLAY_STAGE_CLEAR_HOLD_TICKS before
// playback moves on — see update()'s replay branch.
const replayStageClearHold = new ReplayStageClearHold(REPLAY_STAGE_CLEAR_HOLD_TICKS);
// TIME countdown warning sounds for the live run — see src/timeWarningCue.ts.
const timeWarningCueTracker = new TimeWarningCueTracker();
// Impact feedback of the live run (src/fx/): the hit stop that briefly
// freezes the simulation on a claim, split or miss; the director that times
// every visual effect and the confirm holds that go with them; and the gate
// that keeps a GAME OVER confirm from reaching the core before the modal has
// been drawn. Replay viewing uses none of them.
const hitStop = new HitStop();
let fx: FxDirector;
const gameOverConfirmGate = new GameOverConfirmGate();
// The HUD's `xN` multiplier, as its own span so the multiplier travelling in
// after a split can land on it and highlight it (see renderMultiplierFx()).
let hudMultiplier: HTMLSpanElement;
// The next stage's multiplier travelling from the field center to the HUD.
// The HUD sits outside the canvas, so this one effect is a DOM element.
let multiplierFly: HTMLDivElement;
let lastMultiplierFlyShadow = '';
// The live run's HUD SCORE number counting up to the real score after
// points are added (src/fx/scoreRoll.ts). Ticked next to the director, so it
// keeps counting through a hit stop. Display only: the high score, the GAME
// OVER modal, the X share and the ranking all read session.getScore().
// Replay viewing shows the replay's score as it is.
const hudScoreRoll = new ScoreRoll();
// The live STAGE CLEAR result (src/stageResult.ts): the points the current
// stage scored, from its claim notices, and the count-up shown on the clear
// screen. Reset when the next stage or a new run starts.
const stageResultTally = new StageResultTally();
const stageResultCounter = new StageResultCounter();
// True on a field small enough (a phone held sideways) that the clear
// screen drops its blank lines to stay on it — see fitCanvasToViewport().
let tinyField = false;
// The field's on-screen width / CANVAS_WIDTH, for the effects' smallest
// text size (Renderer.setFxTextMinFontPx()). Updated on every resize.
let fieldDisplayScale = 1;
// The field's on-screen width and height (CSS px), for the hint line's text size.
let fieldCssWidth = CANVAS_WIDTH;
let fieldCssHeight = CANVAS_HEIGHT;
// The Title screen's buttons are the small ones (applyTitleButtonsCompact()).
let titleButtonsCompact = false;
let hudScore: HTMLSpanElement;
// The HUD's lives marks. Line height 0: the marks come from a fallback font
// whose taller metrics would otherwise make the HUD line 1px taller, and with
// it shrink the field.
let hudLives: HTMLSpanElement;
let lastHudScoreRolling = false;
let gameRoot: HTMLDivElement;
let hudRow: HTMLDivElement;
let canvas: HTMLCanvasElement;
let accumulator = 0;
let lastTime = performance.now();
// Tracks the highest value already written to storage, so we only touch
// localStorage when the high score actually changes (docs/plan.md "core
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
// Every displayed value joined into one string (TIME included, which changes
// roughly every 6 ticks), so "nothing changed" is a single comparison. ''
// forces the next write.
let lastHudKey = '';
// The occupancy gauge's last-written state, cached the same way.
let lastGaugeKey = '';

// In-play hints (src/hints/): which one shows, its line over the field
// (src/ui/hintBar.ts) and its mark on the field (src/render/hintLayer.ts).
// Live play only, and display only — they read what a tick did, never feed
// anything back into the input, the run or the score.
const hintSeen = new HintSeenStore();
const hintDirector = new HintDirector<Ember>(hintSeen);
let hintBar: HintBar;
let lastHintMarks: HintMarkShapes | null = null;
// The touch sentences and the button glow (src/input/touch.ts's check).
let touchDevice = false;
// prefers-reduced-motion: the hint's line, marks and glow hold still.
let reducedMotion = false;

// The player's best when the live run started. The live high score follows
// the score during play, so the HUD's goal slot and the GAME OVER modal's NEW
// RECORD compare against this instead. Set on page load and whenever a fresh
// run begins (GAME OVER -> Title).
let runBestAtStart = 0;
// The HUD multiplier's emphasis after it rises or falls back to x1 (live
// play only — see src/hudText.ts).
const multiplierEmphasis = new MultiplierEmphasis();
let lastMultiplierStyleKey = '';
// The occupancy gauge between the HUD row and the field (see getGaugeElements()).
let hudGauge: HTMLDivElement;
let hudGaugeFill: HTMLDivElement;
let hudGaugeGoal: HTMLDivElement;

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

// RANKING: the live run's recorded PLAYING-tick inputs, its successful area
// claims and its per-run id (src/retryFlow.ts's LiveRunTracker). Read exactly
// once per run, at the gameover edge in renderFrame(), where its contents are
// frozen into a RunSubmissionSnapshot handed to src/ui/ranking.ts — that
// module never touches the recorder (or the live session) itself, so a
// submission can never accidentally describe the *next* run. The id moves on
// at the one boundary where a brand-new run begins (GameOver -> Title), so an
// /api/ranking response that arrives after the player has already moved on
// is recognized as belonging to a run that no longer exists and discarded —
// see src/ui/ranking.ts's decideSubmissionOffer().
const runTracker = new LiveRunTracker();

// What the GAME OVER modal's RETRY / TITLE button asked for. Passed to the
// core as confirm on every live tick until the run leaves GAME OVER — past
// the confirm holds the keyboard and the field are under, and past the
// core's own release gate dropping the first ones.
let modalAction: 'retry' | 'title' | null = null;

// Generates a fresh per-run seed for 'normal' mode with `crypto.getRandomValues()`, not
// Math.random — a normal run's board should be unpredictable/unseedable by
// a player, unlike `?seed=` mode's deliberately-reproducible one. Never
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
  // The page language, before any UI is built: `?lang=ja` / `?lang=en`, else
  // the browser's first language (src/i18n/). Fixed for the page load.
  setLocale(detectLocale(window.location.search, navigator.languages ?? []));
  document.documentElement.lang = getLocale();

  explicitSeedParam = parseSeedParam(new URLSearchParams(window.location.search).get('seed'));
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  runBestAtStart = highScore;
  if (explicitSeedParam !== undefined) {
    // `?seed=` pins the whole page load to a 'seeded' run — GameSession's
    // own internal reset (triggered by its 'gameover' case) reuses this
    // same seed for every retry (GameOver -> Title -> Playing) on its own,
    // so main.ts never needs to swap `session` mid-page-load.
    runMode = 'seeded';
    seededRunSeed = explicitSeedParam;
    session = new GameSession({ seed: explicitSeedParam, highScore, captureFeedback: true });
  } else {
    // Normal mode's initial Title board is seeded here, at construction —
    // stage 1's board is already fully built by the time Title is ever
    // shown (see GameSession's own module doc comment), so there's no later
    // "Title -> Playing" moment this could instead hook into.
    session = new GameSession({ seed: generateNormalRunSeed(), highScore, captureFeedback: true });
  }
  // captureFeedback only adds read-only claim/miss notices for the impact
  // feedback below; the run itself (and so its replay) is unchanged.

  // Reduced motion (the OS/browser setting): no shake and no flash. Read at
  // start-up and followed when it changes.
  const reducedMotionQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  reducedMotion = reducedMotionQuery?.matches ?? false;
  fx = new FxDirector(fxParams, { reducedMotion });
  reducedMotionQuery?.addEventListener('change', (event) => {
    reducedMotion = event.matches;
    fx.setReducedMotion(event.matches);
  });
  touchDevice = isTouchCapableDevice();

  gameRoot = getGameRootElement();
  hudRow = getHudRowElement(gameRoot);
  const canvasWrap = getCanvasWrapElement(gameRoot);
  canvas = getCanvasElement(canvasWrap);
  renderer = new Renderer(canvas);
  // A key pressed while HOW TO PLAY is open is not counted until it is
  // released (src/ui/howToPlay.ts), so holding the key that closed it does
  // not start a run.
  keyboard = new KeyboardInput(window, (event) => howToPlay?.keepsKeyDown(event) ?? false);
  // Touch controls dispatch synthetic KeyboardEvents on `window` (their
  // default target), exactly matching KeyboardInput's own listening target
  // above — see input/touch.ts's module comment for how that's a complete
  // merge of the two input sources with no extra glue code.
  new TouchControls(window, document.body);
  attachTapToConfirm(canvas);
  // English-only text keeps the Latin monospace on a Japanese page, so the
  // HUD and the field keep their size (src/ui/sentenceFont.ts).
  markEnglishOnly(gameRoot);
  const touchControls = document.getElementById('touch-controls');
  if (touchControls) markEnglishOnly(touchControls);

  // Initially appended to #hud-row in this order (hud, creditLink, then
  // muteButton). Bottom mode retains that visual order; side mode fixes the
  // two extras in the viewport's top-right corner via #touch-actions-extra,
  // preserving their relative order.
  hud = getHudElement(hudRow);
  hudLine1 = getHudLineElement(hud, 'hud-line1');
  hudLine2 = getHudLineElement(hud, 'hud-line2');
  hudLine3 = getHudLineElement(hud, 'hud-line3');
  hudMultiplier = document.createElement('span');
  hudMultiplier.id = 'hud-multiplier';
  // Bold and drawn larger by a transform, so the line keeps its height.
  hudMultiplier.style.display = 'inline-block';
  hudMultiplier.style.fontWeight = 'bold';
  hudMultiplier.style.transformOrigin = 'center';
  hudMultiplier.style.transform = `scale(${HUD_MULTIPLIER_BASE_SCALE})`;
  ({ gauge: hudGauge, fill: hudGaugeFill, goal: hudGaugeGoal } = getGaugeElements(canvasWrap));
  hudScore = getHudScoreElement();
  hudLives = document.createElement('span');
  hudLives.id = 'hud-lives';
  hudLives.style.lineHeight = '0';
  multiplierFly = getMultiplierFlyElement();
  markEnglishOnly(multiplierFly);
  // The effects' display face: requested now so it is ready by the first
  // claim; the effects fall back to monospace until then (or if it fails).
  loadFxFonts();
  // Matches `hudTwoLineMode`'s own `false` initial value (module scope)
  // until the real, geometry-based decision runs — see updateHudMode() —
  // from the fitCanvasToViewport() call below (which needs the credit
  // link/muteButton to already exist to measure them, so it can't run any
  // earlier than this point in init()).
  hudLine2.style.display = 'none';
  hudLine3.style.display = 'none';
  screen = getScreenElement(canvasWrap);
  hintBar = new HintBar(canvasWrap);
  gameOverModal = initGameOverModal(canvasWrap, {
    onRetry: () => requestModalAction('retry'),
    onTitle: () => requestModalAction('title'),
  });
  rankingUI = initRankingUI({
    anchor: canvasWrap,
    getSession: () => session,
    getRunId: () => runTracker.getRunId(),
    getRulesetVersion: () => RULESET_VERSION,
    getReplayFormatVersion: () => REPLAY_FORMAT_VERSION,
    onReplayStart: enterReplayMode,
    onReplayExit: exitReplayMode,
    // Paused for the duration of a chunked "skip to final stage": that skip
    // steps the same engine between its own yields, so leaving this driver
    // running would advance the replay twice per tick — see the option's own
    // doc comment in src/ui/ranking.ts.
    onReplayAutoAdvanceChange: (autoAdvance: boolean) => {
      replayAutoAdvance = autoAdvance;
      // Recorded for the E2E suite (docs/plan.md §7.2's window.__game__ debug
      // hook): whether playback was actually suspended around a skip is
      // otherwise unobservable from outside, and the bug it guards against
      // (two drivers stepping one engine) is only a few ticks of drift on a
      // short replay — far too small to detect by watching the board.
      // Bounded so it can never grow without limit.
      if (replayAutoAdvanceLog.length < 20) replayAutoAdvanceLog.push(autoAdvance);
    },
    // The submission panel covers the modal: its own RETRY / TITLE ask for
    // the same transition as the modal's buttons.
    onRetry: () => requestModalAction('retry'),
    onTitle: () => requestModalAction('title'),
    // One panel at a time over the Title screen.
    onListOpen: () => howToPlay.close(),
  });
  rankingUI.mountTitleButton();
  howToPlay = new HowToPlayUI({
    anchor: canvasWrap,
    getRankingButton: () => rankingUI.getTitleButton(),
    touch: touchDevice,
    onOpen: () => rankingUI.hideList(),
  });
  // The board's entry score for the HUD's goal slot: asked for once now, and
  // refreshed by each GAME OVER's own ranking check — never during play. A
  // seeded run's goal slot shows the high score, so it does not need it.
  if (runMode === 'normal') rankingUI.loadRankInThreshold();

  sfx = new SfxEngine(loadMuted());
  creditLink = getCreditLinkElement(hudRow);
  muteButton = getMuteButtonElement(hudRow, toggleMute);
  updateMuteButtonLabel();
  // Mobile autoplay restrictions (docs/plan.md §3.8): AudioContext can only
  // start/resume from within a user-gesture handler. Every keydown (real or
  // synthetic, from the touch controls) and every pointerdown is such a
  // gesture; resume() is a cheap no-op once the context is already running.
  window.addEventListener('keydown', () => sfx.resume());
  window.addEventListener('pointerdown', () => sfx.resume());
  // iOS doesn't treat a touch pointerdown as a user activation, and the
  // touch controls preventDefault() it, so no click follows. touchend and
  // pointerup are the events iOS does accept for unlocking audio.
  window.addEventListener('pointerup', () => sfx.resume());
  window.addEventListener('touchend', () => sfx.resume());

  fitCanvasToViewport();
  window.addEventListener('resize', fitCanvasToViewport);
  window.addEventListener('orientationchange', fitCanvasToViewport);

  window.__game__ = {
    session,
    sfx,
    fx,
    hitStop,
    getReplayAutoAdvanceLog: () => [...replayAutoAdvanceLog],
    getHint: () => {
      const view = viewMode === 'live' ? hintDirector.current() : null;
      return view ? { id: view.id, textKey: view.textKey, glow: view.glow, age: view.age } : null;
    },
    getHintMarks: () => lastHintMarks,
    resetHints: () => hintSeen.reset(),
  };

  // Debug panel (docs/plan.md §6 M10 / §12.4): dev-tuning only, never
  // shipped to players. The `import.meta.env.DEV` check is a compile-time
  // constant Vite inlines as `false` in a production build, which turns
  // this whole branch (including the dynamic import call) into unreachable
  // dead code that Vite's build strips entirely — see the module comment in
  // src/debug/panel.ts and the "no debug code in dist/" build check.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('debug')) {
    void import('./debug/panel').then(({ initDebugPanel }) => {
      initDebugPanel(() => session, hudRow, {
        params: fxParams,
        fx,
        hitStop,
        playClaim: (claim) => sfx.playClaim(claim),
        playSplitImpact: () => sfx.playSplitImpact(),
        playMiss: () => sfx.handleEvents(['miss']),
      });
      // The DEBUG badge initDebugPanel() just mounted into hudRow is
      // another non-#hud sibling measureNonHudRowWidth() now has to account
      // for. It mounts asynchronously,
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
  muteButton.textContent = sfx.isMuted() ? t('mute.unmute') : t('mute.mute');
}

function updateTouchLayout(): void {
  const layout = resolveTouchLayout({
    touchCapable: isTouchCapableDevice(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  // Updated on every call, not just on a layout flip: the center column (and
  // with it this font size) changes while resizing within side mode.
  const narrowSideHudFontSize = resolveNarrowSideHudFontSize(layout, window.innerWidth);
  if (narrowSideHudFontSize === null) {
    delete document.body.dataset.touchNarrowSide;
  } else {
    document.documentElement.style.setProperty(
      '--touch-narrow-side-hud-font',
      `${narrowSideHudFontSize}px`,
    );
    document.body.dataset.touchNarrowSide = '';
  }
  if (document.body.dataset.touchLayout === layout) return;

  document.body.dataset.touchLayout = layout;
  if (layout === 'side') {
    const extra = document.getElementById('touch-actions-extra');
    if (!extra) return;
    extra.appendChild(creditLink);
    extra.appendChild(muteButton);
  } else {
    hudRow.appendChild(creditLink);
    hudRow.appendChild(muteButton);
  }
}

// The modal's buttons: only meaningful while the live run is on GAME OVER.
function requestModalAction(action: 'retry' | 'title'): void {
  if (viewMode !== 'live' || session.getStatus() !== 'gameover') return;
  modalAction = action;
}

// What holds a GAME OVER confirm from the keyboard, the field and the touch
// buttons this tick (src/fx/liveTick.ts's GameOverConfirmGate): the guard
// after the modal appears and the ranking offer for the run that just ended.
function currentRetryHold(): RetryHold {
  const checkPending = rankingUI.isSubmissionCheckPending();
  return {
    guardTicks: fxParams.retryConfirmGuardTicks,
    checkPending,
    checkWaitMaxTicks: fxParams.retryOfferWaitMaxTicks,
    formShown: !checkPending && rankingUI.isSubmissionBlockingRetry(),
  };
}

/** The GameSession the render/HUD layer should currently read from — the live `session`, or (while viewing a replay) `replayEngine`'s own session. */
function currentSession(): GameSession {
  return viewMode === 'replay' && replayEngine ? replayEngine.getSession() : session;
}

// REPLAY VIEWING mode switches (see `viewMode`'s module doc comment).
function enterReplayMode(engine: ReplayEngine): void {
  viewMode = 'replay';
  replayEngine = engine;
  replayAutoAdvance = true;
  replayStageClearHold.reset();
  timeWarningCueTracker.reset();
  // Replays are silent, so stop any in-progress
  // continuous draw tone left over from live play — otherwise the live
  // run's audio state leaks into playback.
  sfx.setDrawing(false, null);
  gameOverModal.hide();
  gameOverModalShown = false;
  // The live run's impact feedback does not carry into the replay.
  hitStop.clear();
  fx.reset();
  gameOverConfirmGate.reset();
  renderer.resetBoard();
  multiplierEmphasis.reset();
  renderMultiplierFx(null);
  // No hints over a replay; what the live run has seen stays as it is.
  hintDirector.reset();
  hintBar.hide();
  lastHintMarks = null;
  renderer.setHintMarks(null);
  // Force the next renderFrame() to rewrite the HUD/screen text (they were
  // last written for the live session and must not be left stale).
  lastHudKey = '';
  lastGaugeKey = '';
  lastScreenText = null;
}

function exitReplayMode(): void {
  viewMode = 'live';
  replayEngine = null;
  // A replay left mid-hold must not shorten the next one's first STAGE CLEAR.
  replayStageClearHold.reset();
  // The live run's countdown is tracked afresh after a replay.
  timeWarningCueTracker.reset();
  // The live board is back on screen: the fill reveal must not compare it
  // with the replay's last frame.
  renderer.resetBoard();
  lastHudKey = '';
  lastGaugeKey = '';
  lastScreenText = null;
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
// rather than naming each sibling individually: a hardcoded credit-link +
// mute-button sum silently went stale
// the moment the DEBUG badge was appended after this module's own initial
// layout pass, so any element hudRow ever gains automatically counts here
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
// #hud's *current* font-size — itself a function of window.innerWidth and the
// touch layout alone (the clamp(10px, 3.2vw, 16px) in getHudElement(), or the
// narrow-side size set by updateTouchLayout(), which fitCanvasToViewport()
// runs first), never of hudRow's own width, so this is safe to measure
// before hudRow has been sized for real.
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
  // Measured in the HUD's own language: on a Japanese page, <body> would hand
  // the probe `lang="ja"`, whose generic monospace may be another face with
  // another width than the HUD's (src/ui/sentenceFont.ts).
  markEnglishOnly(probe);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  return width;
}

// Whether switching to the single-line layout right now would actually fit
// without clipping: a *viewport-width-only*
// threshold, this function's predecessor, can't account for a short
// viewport shrinking the canvas — and with it hudRow, which
// fitCanvasToViewport() keeps in sync with the canvas's own on-screen width
// — via *height* rather than width; a wide-but-short window could then still
// clip a single line the old fixed cutoff assumed would fit.
//
// Predicts the single-line layout's own HUD row height first — temporarily
// toggling hudLine2/hudLine3 off to measure hudRow.offsetHeight, then
// restoring whatever display they had (harmless to do speculatively: the
// caller, updateHudMode(), always overwrites their real final display state
// right after based on the actual decision below). A single-line row's
// height depends only on font-size, which — as measureRequiredSingleLineWidth()
// documents — depends only on window.innerWidth and the touch layout, never
// on the row's own width, so this measurement is valid regardless of whatever
// hudRow.style.width currently holds (stale from a previous call, or not yet
// set at all on the very first one). Feeding that height into predictCanvasScale() (the exact
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
// own. The relevant viewport thresholds are covered by
// tests/e2e/narrow-title-hud.spec.ts.
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
  lastHudKey = '';
  updateHud();
}

// Write the HUD text, skipping the DOM write when nothing displayed has
// actually changed since the last call (docs/plan.md §13.3 P3 — see the
// lastHud* module comment above). Shared by renderFrame() (every rendered
// frame, but usually a no-op) and updateHudMode() (once, right after a mode
// flip, to force a rewrite via the invalidated cache).
function updateHud(): void {
  const activeSession = currentSession();
  const game = activeSession.getGame();
  const occupancyPercent = floorPercent(game.getOccupancy());
  const goalPercent = floorPercent(game.getRequiredOccupancy());
  const stage = activeSession.getStage();
  // Live play shows the counting-up value; a replay shows its score as is.
  const score = viewMode === 'replay' ? activeSession.getScore() : hudScoreRoll.value();
  const scoreRolling = viewMode !== 'replay' && hudScoreRoll.isRolling();
  const hi = activeSession.getHighScore();
  const lives = activeSession.getLives();
  const multiplier = activeSession.getMultiplier();
  // TIME: the run's remaining time budget, counting down from
  // GameSession.getTimeLimitTicks() to 0 — a run-wide countdown, not a per-stage elapsed count.
  const remainingTicks = activeSession.getRemainingTicks();
  const timeStr = formatTicks(remainingTicks);
  // Last-30-seconds warning: part of the cache key on its own, because the
  // crossing tick doesn't always land on a decisecond-bucket boundary
  // (formatTicks() only changes its displayed string once every 6 ticks) —
  // without it, the color flip could lag up to 5 ticks behind the instant
  // remainingTicks actually crosses the threshold.
  const timeWarning = remainingTicks <= HUD_TIME_WARNING_TICKS;
  // The goal slot (src/hudGoal.ts): the high score for a seeded run and a
  // replay, otherwise the next target, worked out from the REAL score (not
  // the counting-up display value).
  // A first play has no best to chase until its first point: plain HI then.
  const noBestYet = runBestAtStart === 0 && activeSession.getScore() === 0;
  const goalIsHiScore = viewMode === 'replay' || runMode === 'seeded' || noBestYet;
  const goal = hudGoalText({
    mode: goalIsHiScore ? 'hi' : 'chase',
    score: activeSession.getScore(),
    hiScore: hi,
    bestAtStart: runBestAtStart,
    rankInThreshold: rankingUI.getRankInThreshold(),
  });

  // The SCORE number glows cyan while it counts up. A text-shadow only, so
  // the HUD's line height and width stay as they are.
  if (scoreRolling !== lastHudScoreRolling) {
    lastHudScoreRolling = scoreRolling;
    hudScore.style.textShadow = scoreRolling ? `0 0 6px ${COLOR_FX_NEON_CYAN}, 0 0 12px ${COLOR_FX_NEON_CYAN}` : '';
  }

  updateGauge(occupancyPercent, goalPercent);

  const key = [stage, score, hi, goal, occupancyPercent, goalPercent, lives, multiplier, timeStr, timeWarning, hudTwoLineMode].join('|');
  if (key === lastHudKey) return;
  lastHudKey = key;

  // Mode prefix (runMode.ts's resolveHudModePrefix()): '' for 'normal',
  // `SEED <n>  ` for a `?seed=` run.
  const modePrefix = resolveHudModePrefix(runMode, { seededRunSeed });
  const { lines, timeLine } = hudLines(
    {
      modePrefix,
      stage,
      hiScore: hi,
      goal,
      goalIsHiScore,
      time: timeStr,
      occupancyPercent,
      goalPercent,
    },
    hudTwoLineMode
  );
  // The `xN` multiplier and the SCORE number are their own spans (see
  // `hudMultiplier` / `hudScore`); the lines' text is unchanged by them.
  hudMultiplier.textContent = t('hud.multiplier', multiplier);
  hudScore.textContent = String(score);
  hudLives.textContent = livesText(lives, INITIAL_LIVES);
  const lineElements = hudTwoLineMode ? [hudLine1, hudLine2, hudLine3] : [hudLine1];
  lineElements.forEach((el, index) => {
    el.textContent = '';
    for (const part of lines[index]) {
      if (typeof part === 'string') el.append(part);
      else el.append(part === HUD_SCORE_SLOT ? hudScore : part === HUD_LIVES_SLOT ? hudLives : hudMultiplier);
    }
  });
  // Every line's color is reset first, then the warning color goes only on
  // whichever line carries TIME this frame — a HUD-mode flip
  // (updateHudMode()) can move TIME between lines, and a stale inline color
  // left on the line that *used* to carry it would otherwise persist.
  hudLine1.style.color = '';
  hudLine3.style.color = '';
  if (timeWarning) lineElements[timeLine].style.color = HUD_TIME_WARNING_COLOR;
}

// The occupancy gauge: filled to the current share, with a white mark at the
// goal; the fill turns brighter once HUD_GAUGE_NEAR_GOAL_POINTS or fewer
// points are left. Shown for replays too (it is the board's state, not an
// effect).
function updateGauge(occupancyPercent: number, goalPercent: number): void {
  const near = goalPercent - occupancyPercent <= HUD_GAUGE_NEAR_GOAL_POINTS;
  const key = `${occupancyPercent}|${goalPercent}|${near}`;
  if (key === lastGaugeKey) return;
  lastGaugeKey = key;
  hudGaugeFill.style.width = `${occupancyPercent}%`;
  hudGaugeFill.style.background = near ? HUD_GAUGE_NEAR_COLOR : HUD_GAUGE_FILL_COLOR;
  hudGaugeFill.style.boxShadow = near ? `0 0 6px ${HUD_GAUGE_NEAR_COLOR}` : 'none';
  hudGaugeGoal.style.left = `calc(${goalPercent}% - 1px)`;
  hudGauge.dataset.near = near ? 'true' : 'false';
}

// Moves the travelling multiplier (after a split) from the canvas center to
// the HUD's `xN`, then highlights that `xN` — both driven by the director's
// tick-based progress, so the timing does not depend on the frame rate.
function renderMultiplierFx(frame: FxFrame | null): void {
  const fly = frame?.multiplierFly ?? null;
  if (!fly) {
    if (multiplierFly.style.display !== 'none') multiplierFly.style.display = 'none';
  } else {
    const from = canvas.getBoundingClientRect();
    const toRect = hudMultiplier.isConnected ? hudMultiplier.getBoundingClientRect() : hud.getBoundingClientRect();
    const fromX = from.left + from.width / 2;
    const fromY = from.top + from.height / 2;
    const toX = toRect.left + toRect.width / 2;
    const toY = toRect.top + toRect.height / 2;
    const t = 1 - Math.pow(1 - fly.progress, 3); // ease out
    const scale = 2.5 - 1.5 * t;
    multiplierFly.textContent = fly.text;
    multiplierFly.style.display = 'block';
    // Its glow splits apart for its first ticks (none with reduced motion).
    const fontPx = parseFloat(multiplierFly.style.fontSize) || 16;
    const shadow = multiplierFlyShadow(fly.channelOffset * fontPx);
    if (shadow !== lastMultiplierFlyShadow) {
      lastMultiplierFlyShadow = shadow;
      multiplierFly.style.textShadow = shadow;
    }
    multiplierFly.style.transform =
      `translate(${fromX + (toX - fromX) * t}px, ${fromY + (toY - fromY) * t}px) translate(-50%, -50%) scale(${scale})`;
  }

  // The HUD multiplier's emphasis (src/hudText.ts's MultiplierEmphasis):
  // cyan after it rises, the warning colour after it falls back to x1, larger
  // at first and easing back over HUD_MULTIPLIER_EMPHASIS_TICKS. A rise after
  // a split starts as the travelling multiplier lands, which is when the
  // director's own highlight starts too — the emphasis takes its place, so
  // the two are never shown together. Live play only.
  const emphasis = frame ? multiplierEmphasis.frame() : null;
  const highlight = frame?.multiplierHighlight ?? 0;
  const styleKey = emphasis ? `${emphasis.kind}|${emphasis.strength}` : `h|${highlight}`;
  if (styleKey === lastMultiplierStyleKey) return;
  lastMultiplierStyleKey = styleKey;
  if (emphasis) {
    const color = emphasis.kind === 'up' ? COLOR_FX_NEON_CYAN : HUD_TIME_WARNING_COLOR;
    hudMultiplier.dataset.emphasis = emphasis.kind;
    hudMultiplier.style.color = color;
    hudMultiplier.style.textShadow = `0 0 ${Math.round(4 + 10 * emphasis.strength)}px ${color}`;
    const scale = HUD_MULTIPLIER_BASE_SCALE + HUD_MULTIPLIER_EMPHASIS_EXTRA_SCALE * emphasis.strength;
    hudMultiplier.style.transform = `scale(${Math.round(scale * 1000) / 1000})`;
    return;
  }
  delete hudMultiplier.dataset.emphasis;
  hudMultiplier.style.transform = `scale(${HUD_MULTIPLIER_BASE_SCALE})`;
  if (highlight > 0) {
    hudMultiplier.style.color = COLOR_FX_SPLIT;
    hudMultiplier.style.textShadow = `0 0 ${Math.round(4 + 10 * highlight)}px ${COLOR_FX_SPLIT}`;
  } else {
    hudMultiplier.style.color = '';
    hudMultiplier.style.textShadow = '';
  }
}

// Keeps the canvas's CSS box letterboxed at the fixed 4:3 (CANVAS_WIDTH x
// CANVAS_HEIGHT) aspect ratio inside whatever space is left in #game-root
// once the HUD row above it is accounted for (docs/plan.md §5.3/§12.1) — the
// canvas's internal resolution never changes here, only its on-screen size.
// Re-run on resize/orientation change; #game-root's flex/grid-computed size
// already accounts for the touch controls in either bottom or side mode,
// without this function needing to know whether they're visible.
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
  updateTouchLayout();
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
  fieldDisplayScale = cssWidth / CANVAS_WIDTH;
  fieldCssWidth = cssWidth;
  fieldCssHeight = cssHeight;
  // A small field gets the GAME OVER modal's tighter spacing, so the whole
  // modal stays on the field.
  tinyField = cssHeight < GAMEOVER_MODAL_TINY_BELOW_PX;
  gameOverModal.setDensity(
    tinyField ? 'tiny' : cssHeight < GAMEOVER_MODAL_COMPACT_BELOW_PX ? 'compact' : 'normal'
  );
  // The ranking submission panel, over the modal, packs tighter on the same
  // small fields.
  rankingUI.setSubmitPanelCompact(tinyField);
  // On a small field the Title screen's two buttons shrink into one row
  // along the top edge, clear of the title text.
  applyTitleButtonsCompact();
  // HOW TO PLAY stays clear of RANKING on the new field width.
  howToPlay?.layout();

  // Keep the HUD row exactly as wide as the canvas's on-screen box
  // (docs/plan.md §12.1: "HUDはフィールドと同じ幅・真上に配置").
  hudRow.style.width = `${cssWidth}px`;
}

// Update logic (fixed timestep)
function update(): void {
  if (viewMode !== 'replay') {
    updateLive();
    return;
  }

  // Polled exactly once per tick (KeyboardInput.getInput() consumes the
  // edge-triggered `confirm` pulse on read — calling it twice in the same
  // tick would silently swallow a real confirm press).
  keyboard.getInput();

  // REPLAY VIEWING uses an entirely separate path to isolate side effects.
  // Keyboard input is polled
  // (so a held key doesn't "carry over" as a stale edge-triggered confirm
  // once the player exits back to live play) but never read into core,
  // InputRecorder never observes, highscore is never persisted, sfx never
  // plays.
  if (replayEngine && replayAutoAdvance) {
    const replaySession = replayEngine.getSession();
    // STAGE CLEAR hold: stepTick() confirms a pending StageClear and plays
    // the next stage's first tick in one call, so calling it every tick
    // replaces a cleared stage before a single frame can show it. While the
    // hold lasts the replay session is simply left alone — not even a
    // no-op update() — so its tick count (and with it the HUD's TIME),
    // score, RNG state and position in the recorded input all stand still,
    // and the tick that ends the hold makes the very same stepTick() call
    // an unheld playback would have made. Never reached while a skip is in
    // charge of the engine (replayAutoAdvance is false then), so the hold
    // can't count down behind a skip either.
    const holding = replayStageClearHold.shouldHold({
      status: replaySession.getStatus(),
      finished: replayEngine.isFinished(),
    });
    if (holding) return;
    const advanced = replayEngine.stepTick();
    // Drain (not forward anywhere) every tick, same as a live run —
    // GameSession's own doc comments warn these queues grow unbounded
    // otherwise.
    replaySession.drainEvents();
    replaySession.drainDespawnedEmberPositions();
    if (!advanced) replayAutoAdvance = false;
  }
}

// One live-play tick.
function updateLive(): void {
  // Impact feedback first (src/fx/liveTick.ts): the effects age even while
  // a hit stop holds the run, and a stopped tick ends right here — no input
  // poll (so a confirm pressed meanwhile is read once, on the first tick
  // after the stop), no session.update(), no input recording and no time
  // warning, so the run's tick count and recorded samples stand still. The
  // HUD score's count-up keeps going through a stop, like the effects.
  hudScoreRoll.tick();
  multiplierEmphasis.tick();
  // The clear screen's count-up runs from the tick it is on screen (once
  // SPLIT! has gone), through hit stops like the other display effects.
  stageResultCounter.step(session.getStatus() === 'stageclear', !fx.isSplitBannerActive(), fxParams.stageResultRollTicks);
  const polled = beginLiveTick({
    fx,
    hitStop,
    gate: gameOverConfirmGate,
    status: session.getStatus(),
    readInput: () => keyboard.getInput(),
    retryHold: currentRetryHold,
  });
  if (!polled) {
    // A hit-stopped tick: the hints' time runs on, like the effects'.
    stepHints(null, [], [], false);
    return;
  }

  const statusBeforeThisTick = session.getStatus();
  // The modal's RETRY / TITLE request reaches the core as confirm on every
  // GAME OVER tick until the run leaves it (see `modalAction`).
  if (statusBeforeThisTick !== 'gameover') modalAction = null;
  let input = modalAction !== null && !polled.confirm ? { ...polled, confirm: true } : polled;
  // While HOW TO PLAY is open and for a few ticks after it closes, a confirm
  // is dropped (not kept for later), so the key or tap that closed it does
  // not also start a run. Counted every tick.
  if (howToPlay.dropsConfirm() && input.confirm) input = { ...input, confirm: false };
  // On STAGE CLEAR a confirm first completes the result's count-up (or, under
  // SPLIT!, has it appear complete); only the next one starts the next stage.
  if (statusBeforeThisTick === 'stageclear' && input.confirm && stageResultCounter.isCounting()) {
    stageResultCounter.finish();
    input = { ...input, confirm: false };
  }

  lastInput = input;

  // Seed lifecycle: queue a fresh seed for the gameover-to-title reset.
  // It takes effect whenever
  // resetToFreshRun() next runs. Set every tick while 'gameover' (not just
  // once, on the status-change edge) — simplest correct option, since
  // GameSession.setNextSeed() only cares about whichever value is queued at
  // the instant confirm actually triggers the reset; re-queuing a few dozen
  // times while the GAME OVER screen sits idle is cheap. Never touches a
  // 'seeded' (`?seed=`) run, whose fixed seed must keep reproducing the same
  // board on every retry, exactly as before this feature existed.
  if (runMode === 'normal' && statusBeforeThisTick === 'gameover') {
    session.setNextSeed(generateNormalRunSeed());
  }

  const stageBeforeThisTick = session.getStage();
  // One session update — or, when this confirm ends GAME OVER with anything
  // but the TITLE button, two in a row: GAME OVER -> Title -> stage 1, so
  // the Title screen is never drawn (src/retryFlow.ts).
  const step = stepLiveSession(session, input, {
    retry: modalAction !== 'title',
    // A fresh run begins (GAME OVER -> Title, resetToFreshRun() just ran):
    // the recorder, claims and run id (see `runTracker`), every impact effect
    // and hold, and the best this run is chasing (the high score already
    // includes the run that just ended).
    onFreshRun: () => {
      runTracker.startFreshRun();
      hitStop.clear();
      fx.reset();
      renderer.resetBoard();
      multiplierEmphasis.reset();
      stageResultTally.reset();
      stageResultCounter.clear();
      runBestAtStart = session.getHighScore();
    },
  });
  if (step.freshRun) {
    modalAction = null;
  } else if (statusBeforeThisTick === 'stageclear' && session.getStage() !== stageBeforeThisTick) {
    // The next stage's board replaces this one: drop the effects tied to the
    // old board. SPLIT! and the travelling multiplier keep running.
    hitStop.clear();
    fx.resetBoard();
    renderer.resetBoard();
    stageResultTally.reset();
  }

  const events = session.drainEvents();
  // Records this tick's input if it played a tick (a no-op on title,
  // stageclear and gameover ticks, and on the fresh-run tick itself) and
  // counts its claims.
  runTracker.observe(session, input, events);
  sfx.handleEvents(events);

  // This tick's claim/miss notices -> effects, hit stop, claim/split sounds,
  // and a miss's reason, told apart by the Embers of this same tick (a Blaze
  // or a plain Ember on the contact cell).
  const missReason = (notice: MissFeedback) => t(missReasonKey(notice, session.getGame().getEmbers()));
  const claims = applyImpactNotices(session, fx, hitStop, sfx, missReason);
  for (const notice of claims) stageResultTally.add(notice);
  // The hints read what this tick did. A stage's play starts when the status
  // turns 'playing': a new run's from Title or GAME OVER, a later stage's
  // from STAGE CLEAR.
  const startedPlaying = statusBeforeThisTick !== 'playing' && session.getStatus() === 'playing';
  const stageStart = !startedPlaying ? null : statusBeforeThisTick === 'stageclear' && !step.freshRun ? 'stage' : 'run';
  stepHints(stageStart, claims, events, true);
  // The HUD's SCORE number follows the real score: counting up after points
  // are added, at once when it falls back to 0 for a new run.
  hudScoreRoll.setTarget(session.getScore(), fxParams.scoreRollTicks);
  // After the notices: a split has just started the travelling multiplier.
  multiplierEmphasis.observe(session.getMultiplier(), fx.isMultiplierFlying(), fxParams.multiplierEmphasisTicks);
  // TIME countdown warning: decided here, once per live tick, from the
  // remaining time this tick's session.update() left behind. The replay
  // branch above returns before reaching this, which is what keeps replays
  // silent.
  const timeWarningCue = timeWarningCueTracker.step(session.getRemainingTicks(), session.getStatus());
  if (timeWarningCue) sfx.playTimeWarning(timeWarningCue);
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

// The Title screen's HOW TO PLAY and RANKING buttons, small and in one row on
// a field shown less than TITLE_BUTTONS_COMPACT_BELOW_PX tall.
function applyTitleButtonsCompact(): void {
  titleButtonsCompact = fieldCssHeight < TITLE_BUTTONS_COMPACT_BELOW_PX;
  rankingUI.setTitleButtonCompact(titleButtonsCompact);
  howToPlay?.setCompact(titleButtonsCompact);
}

// Steps the in-play hints once per live tick (src/hints/director.ts).
// `played` is false on a hit-stopped tick, which did nothing but let time run.
function stepHints(
  stageStart: 'run' | 'stage' | null,
  claims: readonly ClaimFeedback[],
  events: readonly GameEvent[],
  played: boolean
): void {
  const game = session.getGame();
  const spawned = played && events.some((e) => e === 'ember-spawned' || e === 'ember-blaze-spawned');
  const embers = game.getEmbers();
  hintDirector.step({
    playing: viewMode === 'live' && session.getStatus() === 'playing',
    stageStart,
    wispCount: game.getWisps().length,
    claims,
    events,
    spawnedEmber: spawned && embers.length > 0 ? embers[embers.length - 1] : null,
    touch: touchDevice,
  });
}

// The hint's mark resolved to cells on the live field: the arrow from the
// marker (none while it draws a line, or when no step leads into the field),
// or the ring's targets where they are now (an Ember that has gone, or an
// Igniter that has gone, leaves no ring).
function resolveHintMark(view: HintView<Ember> | null): ResolvedHintMark | null {
  const mark = view?.mark ?? null;
  if (mark === null) return null;
  const game = session.getGame();
  if (mark.kind === 'arrow') {
    const marker = game.getMarker();
    if (marker.isDrawing()) return null;
    const from = marker.getPosition();
    const dir = hintArrowDirection(game.getField(), from);
    return dir ? { kind: 'arrow', from, dir } : null;
  }
  if (mark.target === 'wisps') return { kind: 'ring', centers: game.getWisps().map((wisp) => wisp.getPosition()) };
  if (mark.target === 'igniter') {
    const position = game.getIgniterPosition();
    return position ? { kind: 'ring', centers: [position] } : null;
  }
  return game.getEmbers().includes(mark.ember) ? { kind: 'ring', centers: [mark.ember.getPosition()] } : null;
}

// Render the current game state, including the HUD and any Title/StageClear/GameOver screen.
function renderFrame(): void {
  const activeSession = currentSession();
  const game = activeSession.getGame();
  const graceTicks = game.getGraceTicks();
  // Miss feedback (docs/plan.md §6 M5): blink the marker off every other
  // MISS_BLINK_INTERVAL_TICKS-tick window for as long as the post-miss grace
  // period lasts; otherwise always visible.
  const markerVisible = graceTicks <= 0 || Math.floor(graceTicks / MISS_BLINK_INTERVAL_TICKS) % 2 === 0;
  // Impact feedback is live play only: a replay is drawn exactly as before.
  const fxFrame = viewMode === 'replay' ? null : fx.getFrame();
  // Read every frame, so the debug panel's value applies at once.
  renderer.setFxTextMinFontPx(fxParams.fxTextMinDisplayPx / fieldDisplayScale);
  renderer.setMissReasonMinFontPx(fxParams.missReasonMinDisplayPx / fieldDisplayScale);
  // The in-play hint: live play only.
  const hintView = viewMode === 'replay' ? null : hintDirector.current();
  lastHintMarks = hintView ? hintMarkShapes(resolveHintMark(hintView), hintView.age, reducedMotion) : null;
  renderer.setHintMarks(lastHintMarks);

  renderer.render(
    game.getField(),
    game.getMarker().getPosition(),
    game.getWisps().map((wisp) => wisp.getTrailRef()),
    game.getEmbers(),
    game.getIgniterPosition(),
    markerVisible,
    fxFrame ?? undefined
  );
  renderMultiplierFx(fxFrame);
  if (viewMode === 'replay') {
    hintBar.hide();
  } else {
    hintBar.render(
      {
        view: hintView,
        markerY: game.getMarker().getPosition().y,
        fieldCssWidth,
        fieldCssHeight,
        reducedMotion,
      },
      (glow) => document.querySelector<HTMLElement>(`#touch-controls button[data-code="${glow === 'fast' ? 'Space' : 'KeyZ'}"]`)
    );
  }

  const status = activeSession.getStatus();

  // RANKING button/list availability: browsing the ranking
  // — and therefore starting a replay, which suspends the live session
  // entirely — is a Title-screen-only affordance, so that a mid-run
  // RANKING -> REPLAY -> EXIT round trip can't be used to pause a
  // time-limited run. Driven from here (rather than from ranking.ts on a
  // timer of its own) so it tracks the same status this frame is rendering;
  // the call is a no-op unless that availability actually flipped.
  rankingUI.syncAvailability();
  // HOW TO PLAY is offered exactly where RANKING is: the live Title screen.
  howToPlay.syncAvailability(viewMode === 'live' && replayEngine === null && status === 'title');

  if (viewMode === 'replay') {
    // No sound effects and no GAME OVER modal/ranking-submission UI: that
    // modal's
    // "POST TO X" button assumes a *live* run's just-finished score
    // (see src/ui/gameOverModal.ts). A replay's own session is never seen on
    // 'title' (ReplayEngine confirms through it before the first frame), so
    // that leaves 'playing' (no overlay), 'stageclear' and 'gameover' — the
    // two overlay lines below.
    updateHud();
    // Keeps the control bar's "STAGE n / N" line in step with the frame being
    // drawn (see RankingUI.syncReplayStatus()).
    rankingUI.syncReplayStatus();
    // End-of-replay wording: "REPLAY FINISHED"
    // read as "the video ended", leaving it ambiguous whether the run itself
    // ended here or the playback merely stopped. It always means the former —
    // a replay is a whole recorded run, so reaching 'gameover' IS the moment
    // that run died — so say so, and show the stage as "n / N" to match the
    // control bar. SCORE and STAGE sit on their OWN lines because placing
    // them side by side overran the overlay's width and wrapped
    // at an arbitrary word, so the layout is fixed here instead of left to
    // the browser.
    const finalStage = replayEngine?.getResult().stage ?? activeSession.getStage();
    let text = '';
    if (status === 'gameover') {
      text = `${t('replay.endHeading')}\n\n${t('replay.endScore', activeSession.getScore())}\n${t('replay.endStage', activeSession.getStage(), finalStage)}`;
    } else if (status === 'stageclear' && replayAutoAdvance && replayEngine && !replayEngine.isFinished()) {
      // Shown for as long as update() holds the cleared stage, with no
      // "press any key" line: playback moves on by itself. The extra
      // conditions keep it to exactly the frames update() is holding on,
      // since anywhere else it would only flash for a single frame: a skip
      // (replayAutoAdvance false) can yield between chunks on a StageClear,
      // and a recording whose input stops on one is never held.
      text = stageClearText(activeSession, { withPrompt: false, withSplitNote: true });
    }
    if (text !== lastScreenText) {
      lastScreenText = text;
      screen.textContent = text;
    }
    return;
  }

  // Continuous line-drawing drone (docs/plan.md §3.8): driven off the
  // marker's actual drawing state plus whichever speed button the most
  // recent tick's merged input held.
  sfx.setDrawing(game.getMarker().isDrawing(), game.getMarker().isDrawing() ? (lastInput.slow ? 'slow' : 'fast') : null);

  updateHud();

  // GAME OVER modal edge trigger (docs/plan-cloudflare-x-share.md Phase 1):
  // show it exactly once on the frame `status` first becomes 'gameover',
  // hide it exactly once when it stops being 'gameover' (RETRY, TITLE, or a
  // key / a tap starting the next run).
  //
  // After a game-ending miss the modal waits FX_GAMEOVER_HOLD_TICKS so the
  // miss itself is seen first, then appears on the first frame after that.
  // GameOverConfirmGate (src/fx/liveTick.ts) drops every confirm from the
  // keyboard and the field until this frame has shown it and for
  // RETRY_CONFIRM_GUARD_TICKS after, so nothing can skip the modal.
  if (status === 'gameover') {
    if (!gameOverModalShown && !fx.isGameOverHeld()) {
      gameOverModalShown = true;
      gameOverConfirmGate.markModalShown();
      const score = session.getScore();
      // NEW RECORD: only for a run that may save its high score (a normal
      // run with no debug override at any point), against the best it
      // started from.
      const recordsHighScore = shouldPersistHighScore(runMode) && !session.isRunTainted();
      gameOverModal.show({
        score,
        stage: session.getStage(),
        hiScore: session.getHighScore(),
        // TIME UP!: distinguishes a
        // time-budget-expired gameover from an ordinary life-loss one — see
        // GameSession.getGameOverReason()'s doc comment for the two causes.
        reason: session.getGameOverReason() ?? undefined,
        newRecordDelta: recordsHighScore && score > runBestAtStart ? score - runBestAtStart : undefined,
      });
      // Ranking submission offer: a no-op if this run isn't POST-eligible
      // (`?seed=`/tainted, see
      // src/ui/ranking.ts's isSnapshotEligible()) or isn't provisionally in
      // range. Everything the offer/POST may ever read about the run is
      // frozen here, synchronously, on the single frame the run ends —
      // `session` (not `activeSession`) deliberately, to make it explicit
      // this is the *live* run's final state and never a replay's.
      rankingUI.offerSubmission({
        runId: runTracker.getRunId(),
        seed: session.getSeed(),
        rle: runTracker.recorder.encode(),
        score,
        stage: session.getStage(),
        runMode,
        tainted: session.isRunTainted(),
        claims: runTracker.getClaims(),
      });
    }
    // The hint says what the keys do: retry, or wait for the submission panel
    // to be closed.
    if (gameOverModalShown) gameOverModal.setSubmissionHold(currentRetryHold().formShown);
  } else {
    gameOverConfirmGate.reset();
    if (gameOverModalShown) {
      gameOverModalShown = false;
      gameOverModal.hide();
      rankingUI.hideAll();
    }
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
    const key = screenTextString(text);
    if (key !== lastScreenText) {
      lastScreenText = key;
      writeScreen(text);
    }
  }
  // With the small Title buttons in a row along the field's top edge, the
  // title text sits a little lower, clear of them.
  const lowered = titleButtonsCompact && status === 'title' && viewMode === 'live' && replayEngine === null;
  const screenTop = lowered ? `calc(50% + ${TITLE_TEXT_COMPACT_OFFSET_PX}px)` : '50%';
  if (screen.style.top !== screenTop) screen.style.top = screenTop;
}

// Writes the Title / STAGE CLEAR overlay. English: one text, exactly
// `body + hint`. Japanese: the hint (a sentence) gets its own span in the
// device's Japanese font, a little smaller since each letter is wider, so the
// result rows above it stay in the monospace face and keep lining up; the
// overlay's whole text still reads `body + hint`.
function writeScreen(text: ScreenText): void {
  if (getLocale() === 'en' || text.hint === '') {
    screen.textContent = screenTextString(text);
    return;
  }
  screen.textContent = text.body;
  const hint = document.createElement('span');
  hint.id = 'screen-hint';
  hint.textContent = text.hint;
  hint.style.fontSize = '0.85em';
  applySentenceFont(hint);
  screen.appendChild(hint);
}

function screenText(status: ReturnType<GameSession['getStatus']>): ScreenText {
  switch (status) {
    case 'title':
      return titleScreenText(session.getHighScore());
    case 'stageclear':
      // While SPLIT! is on the field the clear text waits, so the two never
      // overlap; the split itself is announced by the banner, not by a
      // (SPLIT CLEAR!) line.
      if (fx.isSplitBannerActive()) return EMPTY_SCREEN_TEXT;
      // What the stage scored, counted up (src/stageResult.ts). The cleared
      // stage's Game is still the session's, so its multiplier is the one
      // the stage was played at; the session's is already the next stage's.
      return stageResultScreen({
        stage: session.getStage(),
        values: stageResultCounter.values({
          area: stageResultTally.getArea(),
          bonus: stageResultTally.getBonus(),
          total: stageResultTally.getTotal(),
        }),
        multiplierBefore: session.getGame().getMultiplier(),
        multiplierNext: session.getMultiplier(),
        tight: tinyField,
      });
    case 'gameover':
      // Score info + the "press any key" hint both live inside the
      // GameOverModal now (docs/plan-cloudflare-x-share.md Phase 1) — it's
      // an opaque box centered at this exact same spot, so leaving text here
      // too would just sit invisibly behind it. Returning '' avoids that
      // dead/duplicate node entirely (see the module comment in
      // src/ui/gameOverModal.ts's hint line).
      return EMPTY_SCREEN_TEXT;
    case 'playing':
      return EMPTY_SCREEN_TEXT;
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
