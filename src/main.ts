import { Field } from './core/field';
import { Renderer } from './render/renderer';
import { TICK_DURATION, MAX_FRAME_DELTA } from './config';

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

// Game state
let field: Field;
let renderer: Renderer;
let accumulator = 0;
let lastTime = performance.now();

// Initialize game
function init(): void {
  field = new Field();
  renderer = new Renderer(getCanvasElement());
  renderer.render(field);
}

// Update logic (fixed timestep)
function update(): void {
  // For M0, update is empty - placeholder for future game logic
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
  renderer.render(field);

  // Continue loop
  requestAnimationFrame(gameLoop);
}

// Start game
window.addEventListener('DOMContentLoaded', () => {
  init();
  requestAnimationFrame(gameLoop);
});
