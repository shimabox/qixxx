import { Game } from './core/game';
import { Renderer } from './render/renderer';
import { KeyboardInput } from './input/keyboard';
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

// Get or create the HUD overlay element (occupancy display, §3.3 / §6 M1).
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

// Game state
let game: Game;
let renderer: Renderer;
let keyboard: KeyboardInput;
let hud: HTMLDivElement;
let accumulator = 0;
let lastTime = performance.now();

// Initialize game
function init(): void {
  game = new Game();
  renderer = new Renderer(getCanvasElement());
  keyboard = new KeyboardInput();
  hud = getHudElement();
  renderer.render(game.getField(), game.getMarker().getPosition());
}

// Update logic (fixed timestep)
function update(): void {
  game.update(keyboard.getInput());
}

// Render the current game state, including the HUD.
function renderFrame(): void {
  renderer.render(game.getField(), game.getMarker().getPosition());
  const occupancyPercent = Math.min(100, Math.floor(game.getOccupancy() * 100));
  hud.textContent = `OCCUPANCY: ${occupancyPercent}%`;
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
