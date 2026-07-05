import { GameSession } from './core/session';
import { Renderer } from './render/renderer';
import { KeyboardInput } from './input/keyboard';
import { loadHighScore, saveHighScore } from './storage/highscore';
import { TICK_DURATION, MAX_FRAME_DELTA, HUD_FONT, HUD_TEXT_COLOR } from './config';

// Get or create canvas element
function getCanvasElement(): HTMLCanvasElement {
  let canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    document.body.appendChild(canvas);
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
    hud.style.color = HUD_TEXT_COLOR;
    hud.style.font = HUD_FONT;
    hud.style.pointerEvents = 'none';
    hud.style.userSelect = 'none';
    document.body.appendChild(hud);
  }
  return hud;
}

// Get or create the centered screen overlay (Title / StageClear / GameOver, §4.4/§6 M4).
// Visuals here are intentionally plain text — glow/polish is M5 scope.
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
    screen.style.pointerEvents = 'none';
    screen.style.userSelect = 'none';
    document.body.appendChild(screen);
  }
  return screen;
}

// Game state
let session: GameSession;
let renderer: Renderer;
let keyboard: KeyboardInput;
let hud: HTMLDivElement;
let screen: HTMLDivElement;
let accumulator = 0;
let lastTime = performance.now();
// Tracks the highest value already written to storage, so we only touch
// localStorage when the high score actually changes (docs/plan.md's "core
// never touches localStorage" invariant lives in src/storage/highscore.ts;
// this is just the write-on-change guard, kept here in the DOM-facing layer).
let lastSavedHighScore = 0;

// Initialize game
function init(): void {
  const highScore = loadHighScore();
  lastSavedHighScore = highScore;
  session = new GameSession({ highScore });
  renderer = new Renderer(getCanvasElement());
  keyboard = new KeyboardInput();
  hud = getHudElement();
  screen = getScreenElement();
  renderFrame();
}

// Update logic (fixed timestep)
function update(): void {
  session.update(keyboard.getInput());

  const currentHighScore = session.getHighScore();
  if (currentHighScore > lastSavedHighScore) {
    lastSavedHighScore = currentHighScore;
    saveHighScore(currentHighScore);
  }
}

// Render the current game state, including the HUD and any Title/StageClear/GameOver screen.
function renderFrame(): void {
  const game = session.getGame();
  renderer.render(
    game.getField(),
    game.getMarker().getPosition(),
    game.getWisps().map((wisp) => wisp.getTrail()),
    game.getEmberPositions(),
    game.getIgniterPosition()
  );

  const occupancyPercent = Math.min(100, Math.floor(game.getOccupancy() * 100));
  hud.textContent =
    `STAGE ${session.getStage()}  SCORE: ${session.getScore()}  HI: ${session.getHighScore()}  ` +
    `OCCUPANCY: ${occupancyPercent}%  LIVES: ${session.getLives()}  x${session.getMultiplier()}`;

  screen.textContent = screenText(session.getStatus());
}

function screenText(status: ReturnType<GameSession['getStatus']>): string {
  switch (status) {
    case 'title':
      return `QIXXX\n\nHI SCORE: ${session.getHighScore()}\n\nPRESS ANY KEY TO START`;
    case 'stageclear': {
      const splitNote = session.getGame().getLastClearWasSplit() ? '\n(SPLIT CLEAR!)' : '';
      return `STAGE ${session.getStage()} CLEAR!${splitNote}\n\nPRESS ANY KEY FOR NEXT STAGE`;
    }
    case 'gameover':
      return `GAME OVER\n\nSCORE: ${session.getScore()}\nHI SCORE: ${session.getHighScore()}\n\nPRESS ANY KEY FOR TITLE`;
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
