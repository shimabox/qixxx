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

// Get or create the responsive root that hosts the canvas (docs/plan.md
// §5.3): a flex child that grows/shrinks to fill whatever space is left
// above the touch controls, with the canvas letterboxed inside it at a
// fixed 4:3 aspect ratio via fitCanvasToViewport() below.
function getGameRootElement(): HTMLDivElement {
  let root = document.getElementById('game-root') as HTMLDivElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'game-root';
    root.style.flex = '1 1 auto';
    root.style.minHeight = '0';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';
    root.style.overflow = 'hidden';
    document.body.appendChild(root);
  }
  return root;
}

// Get or create canvas element
function getCanvasElement(root: HTMLDivElement): HTMLCanvasElement {
  let canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    root.appendChild(canvas);
  }
  return canvas;
}

// Get or create the HUD overlay element (stage/score/occupancy/lives/multiplier, §3.3/§6 M1/M4).
function getHudElement(): HTMLDivElement {
  let hud = document.getElementById('hud') as HTMLDivElement | null;
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'hud';
    hud.style.position = 'fixed';
    hud.style.top = '8px';
    hud.style.left = '8px';
    // Leaves room for the fixed top-right mute button (docs/plan.md §5.3:
    // resizing/narrow viewports must not break the layout) instead of
    // wrapping text underneath/behind it.
    hud.style.right = '90px';
    hud.style.color = HUD_TEXT_COLOR;
    hud.style.font = HUD_FONT;
    hud.style.fontSize = 'clamp(10px, 3.2vw, 16px)';
    hud.style.textShadow = `0 0 6px ${HUD_ACCENT_COLOR}`;
    hud.style.pointerEvents = 'none';
    hud.style.userSelect = 'none';
    document.body.appendChild(hud);
  }
  return hud;
}

// Get or create the centered screen overlay (Title / StageClear / GameOver, §4.4/§6 M4).
// Neon text-shadow + a faint glowing box (docs/plan.md §6 M5 visual polish),
// consistent with the canvas's own neon palette (config.ts colors).
function getScreenElement(): HTMLDivElement {
  let screen = document.getElementById('screen') as HTMLDivElement | null;
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'screen';
    screen.style.position = 'fixed';
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
    document.body.appendChild(screen);
  }
  return screen;
}

// Get or create the mute toggle button (docs/plan.md §3.8: "ミュートボタン
// をHUDに置く"). Given its own element (rather than living inside #hud,
// which is pointer-events:none) so it stays clickable/tappable.
function getMuteButtonElement(onToggle: () => void): HTMLButtonElement {
  let button = document.getElementById('mute-button') as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = 'mute-button';
    button.type = 'button';
    button.style.position = 'fixed';
    button.style.top = '8px';
    button.style.right = '8px';
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
    document.body.appendChild(button);
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

// Initialize game
function init(): void {
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  session = new GameSession({ highScore });

  gameRoot = getGameRootElement();
  canvas = getCanvasElement(gameRoot);
  renderer = new Renderer(canvas);
  keyboard = new KeyboardInput();
  // Touch controls dispatch synthetic KeyboardEvents on `window` (their
  // default target), exactly matching KeyboardInput's own listening target
  // above — see input/touch.ts's module comment for why that's a complete
  // merge of the two input sources with no extra glue code.
  new TouchControls(window, document.body);
  attachTapToConfirm(canvas);

  sfx = new SfxEngine(loadMuted());
  muteButton = getMuteButtonElement(toggleMute);
  updateMuteButtonLabel();
  // Mobile autoplay restrictions (docs/plan.md §3.8): AudioContext can only
  // start/resume from within a user-gesture handler. Every keydown (real or
  // synthetic, from the touch controls) and every pointerdown is such a
  // gesture; resume() is a cheap no-op once the context is already running.
  window.addEventListener('keydown', () => sfx.resume());
  window.addEventListener('pointerdown', () => sfx.resume());

  hud = getHudElement();
  screen = getScreenElement();

  fitCanvasToViewport();
  window.addEventListener('resize', fitCanvasToViewport);
  window.addEventListener('orientationchange', fitCanvasToViewport);

  window.__game__ = { session, sfx };

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
// CANVAS_HEIGHT) aspect ratio inside whatever space #game-root currently has
// (docs/plan.md §5.3) — the canvas's internal resolution never changes here,
// only its on-screen size. Re-run on resize/orientation change; #game-root's
// own flex-computed size already accounts for the touch controls' height
// (docs/plan.md's "縦持ちレイアウト: フィールド上部・コントロール下部")
// without this function needing to know whether they're visible.
function fitCanvasToViewport(): void {
  const availW = gameRoot.clientWidth;
  const availH = gameRoot.clientHeight;
  if (availW <= 0 || availH <= 0) return;

  const scale = Math.min(availW / CANVAS_WIDTH, availH / CANVAS_HEIGHT);
  const cssWidth = Math.max(1, Math.floor(CANVAS_WIDTH * scale));
  const cssHeight = Math.max(1, Math.floor(CANVAS_HEIGHT * scale));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

// Update logic (fixed timestep)
function update(): void {
  const input = keyboard.getInput();
  lastInput = input;
  session.update(input);
  sfx.handleEvents(session.drainEvents());

  const currentHighScore = session.getHighScore();
  if (currentHighScore > lastSavedHighScore) {
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
    game.getWisps().map((wisp) => wisp.getTrail()),
    game.getEmberPositions(),
    game.getIgniterPosition(),
    markerVisible
  );

  // Continuous line-drawing drone (docs/plan.md §3.8): driven off the
  // marker's actual drawing state plus whichever speed button the most
  // recent tick's merged input held.
  sfx.setDrawing(game.getMarker().isDrawing(), game.getMarker().isDrawing() ? (lastInput.slow ? 'slow' : 'fast') : null);

  const occupancyPercent = Math.min(100, Math.floor(game.getOccupancy() * 100));
  hud.textContent =
    `STAGE ${session.getStage()}  SCORE: ${session.getScore()}  HI: ${session.getHighScore()}  ` +
    `OCCUPANCY: ${occupancyPercent}%  LIVES: ${session.getLives()}  x${session.getMultiplier()}`;

  screen.textContent = screenText(session.getStatus());
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
