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

// Stage progression (docs/plan.md §12.7, replacing the earlier §3.7 table):
// a single linear interpolation from stage 1 (baseline) to stage
// STAGE_MAX_DIFFICULTY (every parameter at its documented max), stage 11+
// held at the stage-10 values. core/stage.ts's getStageConfig() does the
// interpolating; the constants below only pin down each curve's two
// endpoints. Stage 1's endpoint is simply this file's existing single-value
// constants (WISP_SPEED's implicit x1 multiplier, EMBER_MOVE_TICKS,
// EMBER_BRANCH_CHASE_PROBABILITY, EMBER_SPAWN_INTERVAL_SEC,
// DEFAULT_REQUIRED_OCCUPANCY) — only the stage-10 endpoints need new
// constants (the `_MAX`/`_MIN` ones below).
export const STAGE_MAX_DIFFICULTY = 10;
export const DEFAULT_REQUIRED_OCCUPANCY = 0.65; // stage 1 baseline; escalates to REQUIRED_OCCUPANCY_MAX by stage 10

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

// Wisp spawn-cluster randomization (anti-exploit): previously every stage
// spawned its Wisp cluster dead-center, symmetric around the marker's own
// fixed start column (floor(width/2)). That made "draw one straight line
// straight down from the start" a near-guaranteed instant split-clear on
// stages 2-6 (300-run simulation: 37-59% success, essentially free retries)
// since it always cut the symmetric formation clean in half. The cluster
// center is now drawn from the field's interior — margins below keep it off
// the walls — and then, if it landed too close to the marker's own start
// column, is pushed away (see core/session.ts's buildWisps()) so a single
// center-line slice can no longer reliably separate the whole formation.
// Ratios of field width/height kept clear of the border on each side (e.g.
// 0.2 -> the cluster center's x lands somewhere in [20%, 80%] of the width).
export const WISP_SPAWN_MARGIN_X_RATIO = 0.2;
export const WISP_SPAWN_MARGIN_Y_RATIO = 0.25;
// Minimum horizontal distance (grid cells) the Wisp cluster's center must
// keep from the marker's starting column (floor(width/2)) — the actual
// anti-exploit guarantee. On very small (e.g. test) fields the interior may
// not be wide enough to honor this fully; buildWisps() degrades gracefully
// there (best effort, still fully clamped inside the field).
export const WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN = 15;

// Marker movement rate: number of ticks required to advance one grid cell.
// Fast = 1 tick/cell. Slow (M3, §5.1) halves the effective speed (2 ticks/cell).
export const MARKER_MOVE_TICKS_FAST = 1;
export const MARKER_MOVE_TICKS_SLOW = 2;

// Ember: the border-patrolling enemy (docs/plan.md §3.4 (2) describes this as
// "Sparx"; per §1 the original name is never used in code/UI, hence "Ember").
// It walks the BORDER cell graph (docs/plan.md §4.3), one cell every
// EMBER_MOVE_TICKS ticks (slower than the marker's 1 tick/cell fast rate), and
// a new pair appears every EMBER_SPAWN_INTERVAL_TICKS ticks (docs/plan.md
// §12.7 stage 1: 30s, escalating to EMBER_SPAWN_INTERVAL_MIN_SEC by stage
// STAGE_MAX_DIFFICULTY).
export const EMBER_SPAWN_INTERVAL_SEC = 30;
export const EMBER_SPAWN_INTERVAL_TICKS = EMBER_SPAWN_INTERVAL_SEC * TICK_RATE;
export const EMBER_MOVE_TICKS = 3; // stage 1 baseline; escalates down to EMBER_MOVE_TICKS_MIN by stage 10

// Branch-chase probability (docs/plan.md §6 M8 / §12.2, curve per §12.7): at
// a BORDER-graph branch (2+ non-reversing candidate cells), Ember picks the
// candidate pointing most toward the marker with this probability, instead
// of always preferring to keep going straight. Without this, an Ember on the
// outer ring can maintain its heading forever and never turn onto the branch
// lines created by claimed area, making it a non-threat (real-playtest
// feedback). 0.7 was chosen so Embers reliably threaten the marker along
// inner borders while still occasionally patrolling straight through a
// junction (avoids feeling perfectly omniscient); this is the stage 1
// baseline, escalating to EMBER_BRANCH_CHASE_PROBABILITY_MAX by stage 10.
export const EMBER_BRANCH_CHASE_PROBABILITY = 0.7;

// Ember line-entry generation threshold (docs/plan.md §14 M6-1 "ブレイズ"):
// maybeSpawnEmbers() counts every natural spawn cycle as one "generation"
// (a skipped cycle at the concurrency cap still counts). From this
// generation onward, every Ember spawned that cycle is a "Blaze" — it can
// walk onto LINE cells, not just BORDER (see patrol.ts's `canEnterLine`).
// Debug-panel emberCount overrides and the GameOptions.embers test hook
// always produce plain (non-Blaze) Embers, regardless of generation.
export const EMBER_LINE_ENTRY_GENERATION = 3;

// Stage 1 -> STAGE_MAX_DIFFICULTY interpolation endpoints (docs/plan.md
// §12.7 — replaces the earlier §3.7 stage-2/stage-3+ step constants).
// core/stage.ts's getStageConfig() linearly interpolates every parameter
// between its stage-1 baseline (the plain constants above) and the matching
// `_MAX`/`_MIN` endpoint below, reaching the endpoint exactly at stage
// STAGE_MAX_DIFFICULTY (10) and holding it for every stage beyond that.
export const WISP_SPEED_MULTIPLIER_MAX = 5.0; // stage 10: x5 (docs/plan.md §12.7)
export const EMBER_MOVE_TICKS_MIN = 1; // stage 10: 1 tick/cell (fastest)
export const EMBER_BRANCH_CHASE_PROBABILITY_MAX = 1.0; // stage 10: always chases at a branch
// Stage 10's Ember spawn interval floor. The debug panel's own slider goes
// down to 1s (src/debug/panel.ts RANGES.emberSpawnIntervalSec), but 5s is the
// deliberately chosen in-curve floor (docs/plan.md §12.7's one documented
// deviation from "match the panel's most extreme value"): at 1s, Embers
// would spawn faster than a player can realistically out-maneuver the M11
// containment mechanic, making that counterplay meaningless. 5s keeps Embers
// relentless at stage 10 while leaving room to react.
export const EMBER_SPAWN_INTERVAL_MIN_SEC = 5;
// Max Embers allowed alive at once (docs/plan.md §12.7 "Ember 同時数上限",
// new in M12): bounds both the difficulty curve and worst-case per-frame
// render cost (each Ember draws a glow halo, docs/plan.md §7.3's 60fps
// budget) now that stage 10 can otherwise accumulate Embers indefinitely.
// Game.maybeSpawnEmbers() skips spawning once at this cap, but a debug-panel
// emberCount override (docs/plan.md §6 M10) bypasses it — that's an explicit
// developer action, not the natural stage curve.
export const EMBER_MAX_CONCURRENT_STAGE1 = 2;
export const EMBER_MAX_CONCURRENT_MAX = 10;
export const REQUIRED_OCCUPANCY_MAX = 0.9; // stage 10: 90% (docs/plan.md §12.7)

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
// Deep crimson - Blaze (docs/plan.md §14 M6-1: the line-entering, enhanced
// Ember that spawns from EMBER_LINE_ENTRY_GENERATION onward). Deliberately
// darker/more saturated than both COLOR_EMBER's orange and COLOR_IGNITER's
// brighter red so all three read as visually distinct at a glance.
export const COLOR_EMBER_BLAZE = '#a4133c';

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
// A short descending "pop" for an Ember despawning after losing its BORDER
// footing (docs/plan.md §6 M11 / §12.6) — lower/quicker than the spawn tone
// so the two read as clearly distinct events.
export const SFX_EMBER_DESPAWN_FREQ = 180;
export const SFX_EMBER_DESPAWN_DURATION = 0.07;
// A sharper, higher one-shot for a Blaze spawning (docs/plan.md §14 M6-1
// "通常スポーン音より鋭い音") — higher-pitched and shorter than
// SFX_EMBER_SPAWN_* so the two spawn sounds are clearly distinguishable.
export const SFX_EMBER_BLAZE_SPAWN_FREQ = 420;
export const SFX_EMBER_BLAZE_SPAWN_DURATION = 0.07;
// A short 2-note alarm blip for the instant a Blaze steps from BORDER onto
// LINE (docs/plan.md §14 M6-1 "危険が伝わる短いアラーム"), played via the
// existing playArpeggio() mechanism (see SFX_STAGE_CLEAR_NOTES et al.) —
// no new audio machinery needed.
export const SFX_EMBER_ENTERED_LINE_NOTES = [880, 660];
export const SFX_EMBER_ENTERED_LINE_NOTE_DURATION = 0.05;

// Character visibility (docs/plan.md §6 M9 / §12.3): the marker and enemies
// were all a single 1-cell dot, indistinguishable except by color and hard
// to spot (real-playtest feedback). These constants only enlarge the drawn
// footprint in Renderer — hit/branch/collision logic in src/core/ still
// operates on the single grid cell the character occupies, and every shape
// below is drawn centered on that same cell, so none of this can shift
// collision behavior.

// Marker (self), drawn as a diamond ~3x3 cells across (radius 1.5 cells from
// the cell's center to each point) plus a stronger glow than the generic
// entity glow, since it's the "hero" character.
export const MARKER_DIAMOND_RADIUS_CELLS = 1.5;
export const MARKER_GLOW_BLUR = 10; // px
// Idle "breathing" pulse (§12.3 "待機中は緩やかにパルス"): Renderer applies
// this only while the field has no in-progress LINE cells (equivalent to
// Marker.isDrawing(), inferred from the field it already scans every frame
// rather than a new render() parameter, so the renderer/main.ts call
// signature doesn't need to change).
export const MARKER_PULSE_AMPLITUDE = 0.12; // +/- fraction of the base radius
export const MARKER_PULSE_SPEED = 0.025; // radians per rendered frame (~4s period at 60fps)

// Wisp head, drawn as a bright core + softer halo circle (~2x2 cells across,
// up from the former 1-cell dot). The afterimage trail behind it is
// unchanged (still per-cell fillRect, see WISP_TRAIL_ALPHA_* above).
export const WISP_HEAD_HALO_RADIUS_CELLS = 1.0;
export const WISP_HEAD_CORE_RADIUS_CELLS = 0.55;
export const WISP_HEAD_HALO_ALPHA = 0.35;

// Ember, drawn as a bright core + halo circle (~2x2 cells across) with a
// "flickering ember" animation: halo alpha (and implicitly the perceived
// radius/brightness) oscillates per-frame. Each Ember's flicker is offset by
// its index in the position array (EMBER_FLICKER_PHASE_STEP) so multiple
// Embers don't flicker in perfect unison — still fully deterministic (sine
// of the renderer's own frame counter), no Math.random involved.
export const EMBER_RADIUS_CELLS = 1.0;
export const EMBER_CORE_RADIUS_CELLS = 0.5;
export const EMBER_HALO_ALPHA_BASE = 0.3;
export const EMBER_HALO_ALPHA_VARIANCE = 0.2;
export const EMBER_FLICKER_SPEED = 0.35; // radians per rendered frame
export const EMBER_FLICKER_PHASE_STEP = 2.1; // radians offset per Ember index
// Blaze flicker speed (docs/plan.md §14 M6-1 "速いフリッカー"): noticeably
// faster than EMBER_FLICKER_SPEED so a Blaze reads as more agitated/urgent
// than a plain Ember, echoing how IGNITER_BLINK_SPEED already reads faster
// than EMBER_FLICKER_SPEED.
export const EMBER_BLAZE_FLICKER_SPEED = 0.7;

// Igniter, drawn as a bright core + halo circle (~2x2 cells across) with a
// fast alpha blink (§12.3 "危険が伝わる速めの点滅") — faster than Ember's
// flicker so it reads as more urgent. Never fully invisible
// (IGNITER_BLINK_MIN_ALPHA floors the dip) so it stays clearly visible
// throughout the blink.
export const IGNITER_RADIUS_CELLS = 1.0;
export const IGNITER_CORE_RADIUS_CELLS = 0.5;
export const IGNITER_HALO_ALPHA_BASE = 0.35;
export const IGNITER_BLINK_SPEED = 0.5; // radians per rendered frame
export const IGNITER_BLINK_MIN_ALPHA = 0.4;

// Ember despawn effect (docs/plan.md §6 M11 / §12.6): a trapped Ember
// (standing on a BORDER cell that a claim just pruned into a claimed state,
// see Game.despawnTrappedEmbers()) vanishes rather than freezing in place.
// Renderer draws a short ring at its last position that expands and fades
// over this many rendered frames — purely a render-layer effect (its own
// transient effect list, see render/renderer.ts); core only ever hands up
// the despawn *position* (Game.drainDespawnedEmberPositions()).
export const EMBER_DESPAWN_EFFECT_DURATION_FRAMES = 24; // ~0.4s at a ~60fps render rate
export const EMBER_DESPAWN_EFFECT_MAX_RADIUS_CELLS = 3.0; // ring radius at the end of its life

// Touch controls (docs/plan.md §5.2): screen-bottom virtual d-pad (left) +
// FAST/SLOW buttons (right). Pure layout tuning — sizes in CSS pixels.
export const TOUCH_CONTROLS_HEIGHT = 168;
export const TOUCH_BUTTON_SIZE = 64;
export const TOUCH_DPAD_GAP = 4;
export const TOUCH_CONTROLS_OPACITY = 0.55;
