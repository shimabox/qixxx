// Game field dimensions
export const GRID_WIDTH = 160;
export const GRID_HEIGHT = 120;

// Render scale: grid cells to canvas pixels
export const RENDER_SCALE = 4;
export const CANVAS_WIDTH = GRID_WIDTH * RENDER_SCALE; // 640
export const CANVAS_HEIGHT = GRID_HEIGHT * RENDER_SCALE; // 480

// Game loop timing
export const TICK_RATE = 60; // updates per second
export const TICK_DURATION = 1 / TICK_RATE; // seconds per update
// Max delta time processed in one frame (seconds). Prevents the update loop from
// running thousands of catch-up ticks after the tab was inactive (spiral of death).
export const MAX_FRAME_DELTA = 0.25;

// Stage progression
export const DEFAULT_REQUIRED_OCCUPANCY = 0.65; // 65% for stage 1-2, increases to 75% in stage 3+

// Marker movement rate: number of ticks required to advance one grid cell.
// Fast = 1 tick/cell (only speed implemented in M1).
// Slow (M3) will use this to halve the effective speed (2 ticks/cell).
export const MARKER_MOVE_TICKS_FAST = 1;
export const MARKER_MOVE_TICKS_SLOW = 2;

// Colors (neon-like, not copying original)
export const COLOR_BACKGROUND = '#0a0e27'; // Dark blue-black
export const COLOR_BORDER = '#00ff41'; // Neon green
export const COLOR_CLAIMED_FAST = '#4a7fff'; // Neon blue
export const COLOR_CLAIMED_SLOW = '#ff1555'; // Neon red/pink
export const COLOR_GRID_LINE = 'rgba(255, 255, 255, 0.1)'; // Subtle grid
export const COLOR_LINE = '#ffe066'; // Neon yellow - in-progress line
export const COLOR_MARKER = '#ffffff'; // Marker (player) - bright white

// HUD
export const HUD_FONT = '16px monospace';
export const HUD_TEXT_COLOR = '#ffffff';
