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

// Stage progression (docs/plan.md §3.7): stage 1 and 2 use the explicit
// values below; stage 3+ (2-Wisp stages, see WISP/EMBER/OCCUPANCY *_STAGE3*
// and *_STEP constants further down) escalate difficulty per stage, each
// capped at its documented bound. The exact per-stage curve (how fast each
// value escalates) is an original tuning choice — the plan only pins down
// the stage 1/2 values and the stage 3+ asymptotic bounds (speed x2 cap,
// Ember interval 10s floor, occupancy 75% cap).
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

// Stage 2 tuning (docs/plan.md §3.7): 1 Wisp, x1.15 speed, 25s Ember interval,
// same 65% required occupancy as stage 1.
export const STAGE2_WISP_SPEED_MULTIPLIER = 1.15;
export const STAGE2_EMBER_SPAWN_INTERVAL_SEC = 25;

// Stage 3+ tuning (docs/plan.md §3.7 / §4.2): two Wisps (split-clearable),
// with speed/Ember-interval/required-occupancy escalating one step per stage
// beyond 3, each capped at its documented bound.
export const STAGE3_WISP_COUNT = 2;
export const STAGE3_WISP_SPEED_MULTIPLIER_BASE = 1.3;
export const WISP_SPEED_MULTIPLIER_STEP = 0.1; // + per stage beyond 3
export const WISP_SPEED_MULTIPLIER_MAX = 2.0; // hard cap (docs/plan.md §3.7: "上限×2")

export const STAGE3_EMBER_SPAWN_INTERVAL_SEC = 20;
export const EMBER_SPAWN_INTERVAL_STEP_SEC = 2; // - per stage beyond 3
export const EMBER_SPAWN_INTERVAL_MIN_SEC = 10; // floor (docs/plan.md §3.7: "下限10秒")

export const REQUIRED_OCCUPANCY_STEP = 0.02; // + per stage from stage 3 onward
export const REQUIRED_OCCUPANCY_MAX = 0.75; // cap (docs/plan.md §3.3/§3.7)

// Split multiplier (docs/plan.md §3.6): the score multiplier for a stage is
// `split successes + 1`, capped at 9x, and resets to 1x (0 successes) the
// instant any life is lost.
export const SPLIT_MULTIPLIER_CAP = 9;

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
export const COLOR_EMBER = '#ff8c1a'; // Neon orange - Ember (border patrol)
export const COLOR_IGNITER = '#ff3b3b'; // Neon red - Igniter (line chaser)

// HUD
export const HUD_FONT = '16px monospace';
export const HUD_TEXT_COLOR = '#ffffff';
export const HUD_ACCENT_COLOR = '#00ff41'; // Same neon green as COLOR_BORDER, reused for text-shadow accents (M5)

// Neon glow (docs/plan.md §1/§6 M5). Applied only to a handful of
// small/bounded-count draw calls per frame (marker, Wisp head, Igniter,
// Embers, the in-progress line) — never to the bulk BORDER/CLAIMED field
// fill (tens of thousands of cells), to keep the per-frame cost of
// ctx.shadowBlur negligible and 60fps intact (docs/plan.md §7.3).
export const GLOW_BLUR_ENTITY = 6; // px, for marker/Wisp head/Igniter/Embers
export const GLOW_BLUR_LINE = 4; // px, for in-progress LINE cells
export const GLOW_BLUR_FIELD_EDGE = 10; // px, for the single cached outer-border glow pass

// Wisp trail afterimage fade (docs/plan.md §6 M5 "Wispの残像表現の強化"):
// each successively older trail cell is drawn more transparent, from
// WISP_TRAIL_ALPHA_NEAR (just behind the head) down to WISP_TRAIL_ALPHA_FAR
// (oldest cell), interpolated linearly across the trail's length.
export const WISP_TRAIL_ALPHA_NEAR = 0.55;
export const WISP_TRAIL_ALPHA_FAR = 0.05;

// Miss feedback (docs/plan.md §6 M5 "ミス時の簡易フィードバック"): the
// marker blinks (alternates hidden/visible) every MISS_BLINK_INTERVAL_TICKS
// ticks for as long as the post-miss grace period (MISS_GRACE_TICKS) lasts.
export const MISS_BLINK_INTERVAL_TICKS = 6;

// Effects (docs/plan.md §3.8): Web Audio SE generated at runtime — no audio
// asset files. Frequencies in Hz, durations in seconds, gains as linear
// [0,1] envelope peaks (kept low since several can overlap the same frame).
export const SFX_MASTER_GAIN = 0.25;
export const SFX_DRAW_GAIN = 0.05;
export const SFX_DRAW_FREQ_FAST = 220;
export const SFX_DRAW_FREQ_SLOW = 130;
export const SFX_AREA_CLAIMED_FREQ = 660;
export const SFX_AREA_CLAIMED_DURATION = 0.12;
export const SFX_MISS_FREQ = 90;
export const SFX_MISS_DURATION = 0.35;
export const SFX_STAGE_CLEAR_NOTES = [523, 659, 784, 1047]; // C5 E5 G5 C6 arpeggio
export const SFX_STAGE_CLEAR_NOTE_DURATION = 0.14;
export const SFX_SPLIT_CLEAR_NOTES = [784, 988, 1175, 1568, 1976]; // brighter/longer — a "special" clear
export const SFX_SPLIT_CLEAR_NOTE_DURATION = 0.11;
export const SFX_IGNITER_SPAWN_FREQ = 340;
export const SFX_IGNITER_SPAWN_DURATION = 0.1;
export const SFX_IGNITER_APPROACH_FREQ = 500;
export const SFX_IGNITER_APPROACH_DURATION = 0.05;
export const SFX_EMBER_SPAWN_FREQ = 260;
export const SFX_EMBER_SPAWN_DURATION = 0.08;

// Touch controls (docs/plan.md §5.2): screen-bottom virtual d-pad (left) +
// FAST/SLOW buttons (right). Pure layout tuning — sizes in CSS pixels.
export const TOUCH_CONTROLS_HEIGHT = 168;
export const TOUCH_BUTTON_SIZE = 64;
export const TOUCH_DPAD_GAP = 4;
export const TOUCH_CONTROLS_OPACITY = 0.55;
