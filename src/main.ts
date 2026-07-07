import { GameSession, SessionInput } from './core/session';
import { Renderer } from './render/renderer';
import { KeyboardInput } from './input/keyboard';
import { TouchControls, attachTapToConfirm } from './input/touch';
import { SfxEngine } from './audio/sfx';
import { loadHighScore, saveHighScore } from './storage/highscore';
import { loadMuted, saveMuted } from './storage/settings';
import {
  TICK_DURATION,
  MAX_FRAME_DELTA,
  HUD_FONT,
  HUD_TEXT_COLOR,
  HUD_ACCENT_COLOR,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  MISS_BLINK_INTERVAL_TICKS,
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

// Get or create the HUD overlay element (stage/score/occupancy/lives/multiplier, §3.3/§6 M1/M4).
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
    // Never wraps to a second line (fitCanvasToViewport() below reads this
    // row's *height* to reserve space for the canvas below it; keeping the
    // height stable and independent of the row's width, rather than
    // depending on how much text fits, avoids a circular width<->height
    // layout dependency between the HUD row and the canvas).
    hud.style.whiteSpace = 'nowrap';
    hud.style.overflow = 'hidden';
    hud.style.textOverflow = 'ellipsis';
    hud.style.flex = '1 1 auto';
    hud.style.minWidth = '0';
    row.appendChild(hud);
  }
  return hud;
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
    button.addEventListener('click', onToggle);
    row.appendChild(button);
  }
  return button;
}

// Game state
let session: GameSession;
let renderer: Renderer;
let keyboard: KeyboardInput;
let sfx: SfxEngine;
let hud: HTMLDivElement;
let screen: HTMLDivElement;
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

// Same idea for the Title/StageClear/GameOver overlay (docs/plan.md §13.3
// P3): `null` is a sentinel distinct from any real screenText() result
// (including the 'playing' status's own empty string), guaranteeing the
// very first renderFrame() call always writes once.
let lastScreenText: string | null = null;

// Initialize game. init() runs exactly once on page load. All registered
// event listeners and input controllers (TouchControls, KeyboardInput) live
// for the page's lifetime and are intentionally not disposed — this is not
// an SPA embedded context but a full-page app. Should remounting become
// necessary in the future, design and call explicit dispose() methods then.
function init(): void {
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  session = new GameSession({ highScore });

  gameRoot = getGameRootElement();
  hudRow = getHudRowElement(gameRoot);
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

  // Appended to #hud-row in this order (hud, then muteButton) so the mute
  // button lands at the row's right end (docs/plan.md §12.1: "MUTEボタンは
  // HUD行の右端に統合") — plain flex layout keeps DOM order as visual
  // order here, with no `order` CSS needed.
  hud = getHudElement(hudRow);
  screen = getScreenElement(canvasWrap);

  sfx = new SfxEngine(loadMuted());
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
    void import('./debug/panel').then(({ initDebugPanel }) => initDebugPanel(session, hudRow));
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
// differently at a given viewport width; since #hud never wraps (see
// getHudElement()), that height doesn't depend on the row's *width* — which
// this same function sets below — so a single measure-then-layout pass is
// sufficient and there's no risk of it oscillating.
function fitCanvasToViewport(): void {
  const availW = gameRoot.clientWidth;
  const hudRowHeight = hudRow.offsetHeight;
  const availH = gameRoot.clientHeight - hudRowHeight - HUD_GAP_PX;
  if (availW <= 0 || availH <= 0) return;

  const scale = Math.min(availW / CANVAS_WIDTH, availH / CANVAS_HEIGHT);
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
  session.update(input);
  sfx.handleEvents(session.drainEvents());
  // Ember despawn vanish effect (docs/plan.md §6 M11 / §12.6): drained at
  // tick granularity, same as the events above, so an effect is queued for
  // every despawn even if several ticks elapse before the next rendered
  // frame actually draws it.
  for (const position of session.drainDespawnedEmberPositions()) {
    renderer.spawnEmberDespawnEffect(position);
  }

  const currentHighScore = session.getHighScore();
  // Skip persistence entirely while any debug override is active (docs/plan.md
  // §6 M10: "デバッグパネル使用中はハイスコアを保存しない") — reading/
  // displaying the existing high score (via getHighScore() above and in
  // renderFrame()) is still fine, only the write is suppressed.
  if (currentHighScore > lastSavedHighScore && !session.hasActiveDebugOverrides()) {
    lastSavedHighScore = currentHighScore;
    saveHighScore(currentHighScore);
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
    game.getEmberPositions(),
    game.getIgniterPosition(),
    markerVisible
  );

  // Continuous line-drawing drone (docs/plan.md §3.8): driven off the
  // marker's actual drawing state plus whichever speed button the most
  // recent tick's merged input held.
  sfx.setDrawing(game.getMarker().isDrawing(), game.getMarker().isDrawing() ? (lastInput.slow ? 'slow' : 'fast') : null);

  const occupancyPercent = Math.min(100, Math.floor(game.getOccupancy() * 100));
  const stage = session.getStage();
  const score = session.getScore();
  const hi = session.getHighScore();
  const lives = session.getLives();
  const multiplier = session.getMultiplier();
  if (
    stage !== lastHudStage ||
    score !== lastHudScore ||
    hi !== lastHudHi ||
    occupancyPercent !== lastHudOccupancy ||
    lives !== lastHudLives ||
    multiplier !== lastHudMultiplier
  ) {
    lastHudStage = stage;
    lastHudScore = score;
    lastHudHi = hi;
    lastHudOccupancy = occupancyPercent;
    lastHudLives = lives;
    lastHudMultiplier = multiplier;
    hud.textContent =
      `STAGE ${stage}  SCORE: ${score}  HI: ${hi}  ` +
      `OCCUPANCY: ${occupancyPercent}%  LIVES: ${lives}  x${multiplier}`;
  }

  const status = session.getStatus();
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
      return `GAME OVER\n\nSCORE: ${session.getScore()}\nHI SCORE: ${session.getHighScore()}\n\nPRESS ANY KEY OR TAP FOR TITLE`;
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
