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

// Lives (M2, docs/plan.md §3.5)
export const INITIAL_LIVES = 3;
// Grace period after a miss (ticks) during which no further miss can be
// triggered (docs/plan.md §3.5 sanity: without it, an enemy sharing the
// marker's cell — e.g. an Ember passing over a stationary marker — would
// re-trigger a miss on every consecutive tick and drain all lives from a
// single contact). Normal updates (enemy movement, line drawing) continue
// during the grace period; only miss detection is suspended.
export const MISS_GRACE_TICKS = 120; // 2s at TICK_RATE=60

// Wisp: the line-dwelling wandering enemy (docs/plan.md §3.4 describes this as
// "QIX"; per §1 the original name is never used in code/UI, hence "Wisp").
// It moves with a continuous heading + per-tick random jitter, reflecting
// off any non-UNCLAIMED cell (docs/plan.md §4.3).
export const WISP_SPEED = 0.3; // grid cells advanced per tick (pure tuning value)
export const WISP_TURN_JITTER = 0.2; // max random heading change per tick, radians
// The trail records the head's grid cell each time it changes, so it always
// spans this many *distinct* cells (8-12 per docs/plan.md §4.3).
export const WISP_HISTORY_LENGTH = 10;

// Marker movement rate: number of ticks required to advance one grid cell.
// Fast = 1 tick/cell. Slow (M3, §5.1) halves the effective speed (2 ticks/cell).
export const MARKER_MOVE_TICKS_FAST = 1;
export const MARKER_MOVE_TICKS_SLOW = 2;

// Ember: the border-patrolling enemy (docs/plan.md §3.4 (2) describes this as
// "Sparx"; per §1 the original name is never used in code/UI, hence "Ember").
// It walks the BORDER cell graph (docs/plan.md §4.3), one cell every
// EMBER_MOVE_TICKS ticks (slower than the marker's 1 tick/cell fast rate), and
// a new pair appears every EMBER_SPAWN_INTERVAL_TICKS ticks (docs/plan.md
// §3.7 stage 1: 30s).
export const EMBER_SPAWN_INTERVAL_SEC = 30;
export const EMBER_SPAWN_INTERVAL_TICKS = EMBER_SPAWN_INTERVAL_SEC * TICK_RATE;
export const EMBER_MOVE_TICKS = 3;

// Igniter: the enemy that chases up the player's in-progress line from its
// root (docs/plan.md §3.4 (3) describes this as "Fuse"; per §1 the original
// name is never used in code/UI, hence "Igniter"). It spawns once the player
// has held still, mid-line, for IGNITER_SPAWN_STILL_TICKS ticks (§3.4: ~1s),
// then advances one line-cell every IGNITER_ADVANCE_TICKS ticks while the
// player remains still (docs/plan.md §4.3).
export const IGNITER_SPAWN_STILL_TICKS = 60; // 1s at TICK_RATE=60
export const IGNITER_ADVANCE_TICKS = 6;

// Scoring (docs/plan.md §3.6): area claims are worth SCORE_PER_CELL_* points
// per cell (slow lines score double), truncated to an integer. Stage-clear
// bonus is the excess-occupancy percentage points times
// STAGE_CLEAR_BONUS_PER_PERCENT_POINT (e.g. 70% achieved vs 65% required ->
// 5 * 100 = 500).
export const SCORE_PER_CELL_FAST = 0.5;
export const SCORE_PER_CELL_SLOW = 1.0;
export const STAGE_CLEAR_BONUS_PER_PERCENT_POINT = 100;
export const DEFAULT_SCORE_MULTIPLIER = 1;

// Colors (neon-like, not copying original)
export const COLOR_BACKGROUND = '#0a0e27'; // Dark blue-black
export const COLOR_BORDER = '#00ff41'; // Neon green
export const COLOR_CLAIMED_FAST = '#4a7fff'; // Neon blue
export const COLOR_CLAIMED_SLOW = '#ff1555'; // Neon red/pink
export const COLOR_GRID_LINE = 'rgba(255, 255, 255, 0.1)'; // Subtle grid
export const COLOR_LINE = '#ffe066'; // Neon yellow - in-progress line
export const COLOR_MARKER = '#ffffff'; // Marker (player) - bright white
export const COLOR_WISP_HEAD = '#b967ff'; // Neon purple - Wisp head
export const COLOR_WISP_TRAIL = 'rgba(185, 103, 255, 0.35)'; // Faded Wisp afterimage
export const COLOR_EMBER = '#ff8c1a'; // Neon orange - Ember (border patrol)
export const COLOR_IGNITER = '#ff3b3b'; // Neon red - Igniter (line chaser)

// HUD
export const HUD_FONT = '16px monospace';
export const HUD_TEXT_COLOR = '#ffffff';
