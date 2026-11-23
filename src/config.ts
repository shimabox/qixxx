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

// Stage progression: every stage has its own character instead of every value
// rising together with the stage number. Each row of STAGE_TABLE is one
// stage (row 0 = stage 1); every stage past the last row plays the last row.
// core/stage.ts's getStageConfig() reads it.
//
// `titleId` names the stage's title shown when it starts (the text itself is
// in src/i18n/messages.ts, `stageTitle.<titleId>`). `firstEmberSec` is how
// long the stage waits before its first Ember pair; later pairs follow every
// `emberSpawnIntervalSec`. `emberMoveTicks` is ticks per border cell (smaller
// is faster).
//
// Stages 4 and 11 are scoring stages (many slow Wisps, easy to split for a
// big multiplier) and stage 6 is a breather. Outside those three, no step
// from one stage to the next raises both the Wisp count and their speed at
// once, no stage moves Wisps faster than x3.0 and no goal is above 80%
// (src/core/stage.test.ts holds the table to this).
export interface StageTableRow {
  titleId: StageTitleId;
  wispCount: number;
  wispSpeedMultiplier: number;
  emberSpawnIntervalSec: number;
  firstEmberSec: number;
  maxConcurrentEmbers: number;
  emberMoveTicks: number;
  requiredOccupancy: number;
}
export type StageTitleId =
  | 'warmUp'
  | 'fastPair'
  | 'trio'
  | 'slowSwarm'
  | 'emberRush'
  | 'breather'
  | 'quartet'
  | 'fastFour'
  | 'quintet'
  | 'fastFive'
  | 'bigSwarm'
  | 'emberStorm'
  | 'sextet'
  | 'fastSix'
  | 'final';
// Stage 1 alone brings its first Ember sooner than its interval, so a first
// run meets one early. The debug panel can override this for every stage.
export const EMBER_FIRST_SPAWN_SEC = 15;
const stageRow = (
  titleId: StageTitleId,
  wispCount: number,
  wispSpeedMultiplier: number,
  emberSpawnIntervalSec: number,
  maxConcurrentEmbers: number,
  emberMoveTicks: number,
  requiredOccupancy: number,
  firstEmberSec: number = emberSpawnIntervalSec
): StageTableRow => ({
  titleId,
  wispCount,
  wispSpeedMultiplier,
  emberSpawnIntervalSec,
  firstEmberSec,
  maxConcurrentEmbers,
  emberMoveTicks,
  requiredOccupancy,
});
export const STAGE_TABLE: readonly StageTableRow[] = [
  stageRow('warmUp', 2, 1.0, 30, 2, 3, 0.65, EMBER_FIRST_SPAWN_SEC), // 1
  stageRow('fastPair', 2, 1.6, 27, 3, 3, 0.68), // 2
  stageRow('trio', 3, 1.6, 24, 4, 3, 0.7), // 3
  stageRow('slowSwarm', 6, 1.0, 24, 4, 3, 0.6), // 4: scoring stage
  stageRow('emberRush', 3, 1.8, 12, 6, 2, 0.72), // 5
  stageRow('breather', 2, 1.4, 30, 2, 3, 0.6), // 6: breather
  stageRow('quartet', 4, 1.8, 19, 6, 2, 0.75), // 7
  stageRow('fastFour', 4, 2.4, 16, 7, 2, 0.78), // 8
  stageRow('quintet', 5, 2.4, 13, 8, 2, 0.8), // 9
  stageRow('fastFive', 5, 3.0, 10, 8, 1, 0.8), // 10
  stageRow('bigSwarm', 8, 1.2, 20, 4, 3, 0.65), // 11: scoring stage
  stageRow('emberStorm', 3, 2.4, 6, 10, 1, 0.75), // 12
  stageRow('sextet', 6, 2.4, 12, 8, 2, 0.8), // 13
  stageRow('fastSix', 6, 3.0, 10, 8, 1, 0.8), // 14
  stageRow('final', 7, 3.0, 8, 10, 1, 0.8), // 15 and every stage after it
];
// The lowest goal of any stage: the largest stage-clear bonus a stage can give
// is measured from it (functions/_lib/scoreLimits.ts).
export const MIN_REQUIRED_OCCUPANCY = Math.min(...STAGE_TABLE.map((row) => row.requiredOccupancy));
// The goal a standalone Game uses when none is given (tests): stage 1's.
export const DEFAULT_REQUIRED_OCCUPANCY = STAGE_TABLE[0].requiredOccupancy;

// Time limit: every run is capped at
// a fixed time *budget* instead of running until lives run out — the whole
// point of the "5分で1本" reframing, later
// shortened to 3 minutes (2026-08-16 playtest decision). 10800 ticks = 180s
// (3 minutes) at TICK_RATE=60. core/session.ts's GameSession counts this down
// from getTotalTicks() (playing-only, same rule as the tick counters it
// already tracked) and forces a 'gameover' the instant it hits 0, regardless
// of lives remaining — see GameSession.getGameOverReason() and
// GameSession.getRemainingTicks(). SessionOptions.timeLimitTicks (a test
// hook) and the debug panel's own time-limit slider
// (GameSession.setDebugTimeLimitTicks(), src/debug/panel.ts) can both
// override this per-session; this constant is only the real-play default.
export const TIME_LIMIT_TICKS = 10800;

// Lives (M2, docs/plan.md §3.5)
export const INITIAL_LIVES = 3;

// EASY (src/core/difficulty.ts), chosen on the Title screen: every stage's
// Wisps move at the stage table's speed times EASY_WISP_SPEED_FACTOR, and a
// new run starts with EASY_INITIAL_LIVES (carried across stages as on
// NORMAL). Everything else — time, Embers, goals, scoring — is NORMAL's.
export const EASY_WISP_SPEED_FACTOR = 0.7;
export const EASY_INITIAL_LIVES = 5;
// The GAME OVER screen suggests EASY once EASY_PROMPT_STREAK_RUNS kept runs
// in a row (the play log's newest, this one included) ended on stage
// EASY_PROMPT_STREAK_STAGE or earlier. Back on the Title screen after it, the
// MODE button's border lights up and pulses EASY_PROMPT_TOGGLE_PULSE_COUNT
// times, EASY_PROMPT_TOGGLE_PULSE_SEC each (lit and still with reduced
// motion), in EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR. Its glow (a box-shadow, CSS
// px) is EASY_PROMPT_TOGGLE_GLOW_REST_* while lit and at each end of a pulse,
// and EASY_PROMPT_TOGGLE_GLOW_PEAK_* in the middle of a pulse.
export const EASY_PROMPT_STREAK_RUNS = 3;
export const EASY_PROMPT_STREAK_STAGE = 3;
export const EASY_PROMPT_TOGGLE_PULSE_COUNT = 3;
export const EASY_PROMPT_TOGGLE_PULSE_SEC = 1.6;
export const EASY_PROMPT_TOGGLE_HIGHLIGHT_COLOR = '#ffffff';
export const EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX = 6;
export const EASY_PROMPT_TOGGLE_GLOW_REST_SPREAD_PX = 1;
export const EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX = 14;
export const EASY_PROMPT_TOGGLE_GLOW_PEAK_SPREAD_PX = 5;
// Grace period after a miss (ticks) during which no further miss can be
// triggered (docs/plan.md §3.5 sanity: without it, an enemy sharing the
// marker's cell — e.g. an Ember passing over a stationary marker — would
// re-trigger a miss on every consecutive tick and drain all lives from a
// single contact). Normal updates (enemy movement, line drawing) continue
// during the grace period; only miss detection is suspended.
export const MISS_GRACE_TICKS = 60; // 1s at TICK_RATE=60
// For this many ticks after a miss no new line can be started (moving along
// the border stays free), so the invincibility is not a free pass to draw.
// Shorter than MISS_GRACE_TICKS, so the player is back to drawing soon:
// a line started in the rest of the grace cannot be missed on until the
// grace ends. The debug panel can change both at run time.
export const MISS_LINE_LOCK_TICKS = 30; // 0.5s

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
// keep from the marker's starting column when the marker starts on the top
// or bottom edge (floor(width/2) on stage 1) — the actual anti-exploit
// guarantee. On very small (e.g. test) fields the interior may
// not be wide enough to honor this fully; buildWisps() degrades gracefully
// there (best effort, still fully clamped inside the field).
export const WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN = 15;
// The same guarantee for a marker that starts on the left or right edge: the
// cluster center keeps at least this many rows from the marker's starting
// row. The Wisps line up in one row, so a center on the start row would put
// the whole cluster in reach of one straight line from the start.
export const WISP_SPAWN_MIN_OFFSET_FROM_MARKER_ROW = 15;

// Where on its edge the marker may start a stage, as fractions of the edge's
// length (core/markerStart.ts): each of the four edges offers these points,
// in this order, so there are 4 x (this list's length) candidates — one at
// the middle of each edge. Stage 1 always starts at the top edge's middle;
// from stage 2 one candidate is drawn at random per stage.
export const MARKER_START_FRACTIONS: readonly number[] = [0.5];

// Marker movement rate: number of ticks required to advance one grid cell.
// Fast = 1 tick/cell. Slow (M3, §5.1) halves the effective speed (2 ticks/cell).
export const MARKER_MOVE_TICKS_FAST = 1;
export const MARKER_MOVE_TICKS_SLOW = 2;

// Ember: the border-patrolling enemy (docs/plan.md §3.4 (2) describes this as
// "Sparx"; per §1 the original name is never used in code/UI, hence "Ember").
// It walks the BORDER cell graph (docs/plan.md §4.3), one cell every
// EMBER_MOVE_TICKS ticks (slower than the marker's 1 tick/cell fast rate), and
// a new pair appears every EMBER_SPAWN_INTERVAL_TICKS ticks. These are the
// defaults of a standalone Game (tests); a real stage takes its own values
// from STAGE_TABLE above.
export const EMBER_SPAWN_INTERVAL_SEC = STAGE_TABLE[0].emberSpawnIntervalSec;
export const EMBER_SPAWN_INTERVAL_TICKS = EMBER_SPAWN_INTERVAL_SEC * TICK_RATE;
export const EMBER_MOVE_TICKS = STAGE_TABLE[0].emberMoveTicks;
export const EMBER_MAX_CONCURRENT_DEFAULT = STAGE_TABLE[0].maxConcurrentEmbers;

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

// The branch-chase probability is the one stage value still interpolated
// (core/stage.ts): linearly from EMBER_BRANCH_CHASE_PROBABILITY at stage 1 to
// EMBER_BRANCH_CHASE_PROBABILITY_MAX at EMBER_BRANCH_CHASE_MAX_STAGE, held
// there for every later stage.
export const EMBER_BRANCH_CHASE_PROBABILITY_MAX = 1.0; // always chases at a branch
export const EMBER_BRANCH_CHASE_MAX_STAGE = 10;
// A stage's `maxConcurrentEmbers` (STAGE_TABLE) bounds both the difficulty
// and the worst-case per-frame render cost (each Ember draws a glow halo).
// Game.maybeSpawnEmbers() skips spawning once at that cap, but a debug-panel
// emberCount override bypasses it — that's an explicit developer action, not
// the stage's own value.

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
// A big claim: one claim that fills at least BIG_CLAIM_SHARE of the field
// (the same denominator as the occupancy) scores its area points times
// BIG_CLAIM_MULTIPLIER, applied before the one truncation to an integer
// (core/scoring.ts). The threshold itself counts. A split claim is scored
// the same way. The debug panel can change both at run time.
export const BIG_CLAIM_SHARE = 0.15;
export const BIG_CLAIM_MULTIPLIER = 1.5;
// A close call: while a line is being drawn, every tick after the enemies
// move, a Wisp head within NEAR_MISS_DISTANCE_CELLS (the larger of the x and
// y differences) of a cell of that line or of the marker marks the line.
// Closing a marked line into an accepted claim adds NEAR_MISS_BONUS x the
// multiplier, once. The mark goes whenever the line does (a miss, a
// rejected or accepted claim, retracting back to the start). The debug
// panel can change both at run time.
export const NEAR_MISS_DISTANCE_CELLS = 3;
export const NEAR_MISS_BONUS = 200;

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

// TIME countdown warning: the HUD
// line carrying TIME switches to this color once
// GameSession.getRemainingTicks() drops to/below HUD_TIME_WARNING_TICKS
// (30s), in both the single-line and stacked-lines HUD layouts (main.ts's
// updateHud()) — a last-30-seconds cue that the run is about to hard-cut off
// regardless of lives remaining. Reuses the same neon-red hue as
// COLOR_IGNITER (already the palette's "danger" color) rather than
// introducing a fourth alarm color.
export const HUD_TIME_WARNING_TICKS = 30 * TICK_RATE;
export const HUD_TIME_WARNING_COLOR = '#ff3b3b';
// TIME countdown warning sounds (src/timeWarningCue.ts decides the tick,
// audio/sfx.ts's playTimeWarning() plays it): the audible counterpart of the
// color change above, for a player whose eyes are on the board. A rising
// alarm sweeps once on the tick the remaining time reaches
// HUD_TIME_WARNING_TICKS — the same tick TIME turns red — and once more, with
// the same sound, at SFX_TIME_WARNING_SECOND_ALARM_SEC (the HUD does not
// change there: TIME is already red). Then a short beep marks every whole
// second from SFX_TIME_WARNING_BEEP_FROM_SEC down to 1, switching to a higher
// pitch from SFX_TIME_WARNING_HIGH_FROM_SEC. Nothing plays at 0: that tick is
// the TIME UP gameover itself.
// The beeps sit well above the Igniter approach beep (500 Hz) and apart from
// the area-claim hit (SFX_CLAIM_HIT_FREQ), so neither can be mistaken for them.
export const SFX_TIME_WARNING_SECOND_ALARM_SEC = 15;
export const SFX_TIME_WARNING_BEEP_FROM_SEC = 10;
export const SFX_TIME_WARNING_HIGH_FROM_SEC = 5;
export const SFX_TIME_WARNING_ALARM_FREQ_START = 440;
export const SFX_TIME_WARNING_ALARM_FREQ_END = 880;
export const SFX_TIME_WARNING_ALARM_DURATION = 0.4;
export const SFX_TIME_WARNING_BEEP_FREQ = 880;
export const SFX_TIME_WARNING_BEEP_HIGH_FREQ = 1320; // 1.5x the plain beep
export const SFX_TIME_WARNING_BEEP_DURATION = 0.07; // both beeps
// The HUD switches from its single nowrap+ellipsis line to its
// stacked-lines layout (main.ts's updateHudMode(), hudLine2/hudLine3) so
// STAGE/SCORE/HI/TIME/OCCUPANCY/LIVES/xN all stay visible instead of being
// clipped by the ellipsis. See main.ts's updateHudMode()/wouldSingleLineFit()
// doc comments for the decision itself:
// a *viewport-width-only* threshold (this constant's previous form) can't
// account for a short viewport shrinking the canvas — and with it the HUD
// row it's kept in sync with — via height rather than width, so a wide-but-
// short window could still clip a "should fit" single line. The decision is
// now geometry-based (predicts the single-line row's actual on-screen
// width, the same way fitCanvasToViewport() itself sizes the canvas) rather
// than a fixed cutoff, so this constant is only the *text* half of that
// calculation — see below.
//
// Deliberately generous worst-case single-line stats text (main.ts's
// measureRequiredSingleLineWidth()) used to size that decision: 3-digit
// STAGE, 6-digit SCORE/HI (just under 1,000,000), TIME (a run-total countdown from TIME_LIMIT_TICKS
// down to 0, so its on-screen width is fixed at "D:SS.D" — single-digit
// minutes, since TIME_LIMIT_TICKS's default 180s never reaches a 2-digit
// minute — for the entire run, not just a worst case; 3:00.0 is simply its
// starting/maximum value), 100% OCCUPANCY, and x9 (SPLIT_MULTIPLIER_CAP —
// LIVES never exceeds a single digit; nothing in core/ grants extra lives
// past INITIAL_LIVES) — measures comfortably under the previous (pre-time-
// limit, unbounded-per-stage-clock) budget at the HUD's 16px-capped font. A
// 'seeded' run's `SEED <n>  ` prefix (runMode.ts's resolveHudModePrefix())
// is measured on top of this at its own actual (already-fixed-for-the-page-
// load) value, not re-guessed here, since unlike SCORE/HI it can't change
// after `?seed=` is parsed.
//
// The debug panel's own time-limit slider (src/debug/panel.ts) can push
// TIME_LIMIT_TICKS past this budget's single-digit-minute assumption (e.g.
// a 10-minute override) — a deliberately out-of-budget edge case for that
// dev-only tool, exactly like a 7+-digit cumulative score, rather than one
// this sizing protects against. A 7+-digit cumulative score remains the
// other accepted residual.
//
// The goal slot (src/hudGoal.ts) replaced `HI: <n>` in the single line, and
// the occupancy now reads `<current>%/<goal>% <left>% LEFT` (src/hudText.ts):
// its widest form is 16 characters, since the goal is always two digits
// (every STAGE_TABLE goal is 60%-80%) and the points left
// can only have two digits while the current share has one or two. The
// widest goal is `TO BEST <6 digits>`, and the lives are INITIAL_LIVES marks
// (or `◆xN` for a dev-only override past them). The colons went, so this
// text is no wider than the one it replaced. An EASY run is measured with
// its `EASY  ` lead and EASY_INITIAL_LIVES marks instead (src/hudText.ts's
// hudWorstCaseStatsText()).
export const HUD_WORST_CASE_STATS_TEXT =
  'STAGE 999  SCORE 999999  TO BEST 999999  TIME 3:00.0  10%/90% 80% LEFT  ◆◆◇  x9';

// #hud-row's internal flex `gap` (main.ts's getHudRowElement()), between
// #hud / the credit link / the mute button. Kept as a constant — like
// HUD_GAP_PX above — so main.ts's single-line-fit prediction
// (measureNonHudRowWidth()) stays in sync with the actual CSS value instead
// of re-deriving it via a live layout measurement that would require the
// row to already be at its final width.
export const HUD_ROW_GAP_PX = 8;

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
// (oldest cell), interpolated linearly across the trail's length. Every
// cell the trail can hit is drawn (src/render/wispShape.ts) — the cells
// between two trail points take a value between theirs — and even the
// oldest is plainly visible, since all of it is deadly.
export const WISP_TRAIL_ALPHA_NEAR = 0.8;
export const WISP_TRAIL_ALPHA_FAR = 0.35;
// A faint glow of the trail's own color around its cells, WISP_TRAIL_GLOW_CELLS
// wide on each side at WISP_TRAIL_GLOW_ALPHA_RATIO of the cells' opacity, so the
// trail reads thicker than a line. Drawing only: the cells themselves are
// the part that hits, and the glow stays clearly fainter than them.
export const WISP_TRAIL_GLOW_CELLS = 0.5;
export const WISP_TRAIL_GLOW_ALPHA_RATIO = 0.35;
// The trail's color follows the Wisp's speed multiplier: COLOR_WISP_HEAD at
// x1, COLOR_WISP_TRAIL_FAST from WISP_TRAIL_FAST_AT_MULTIPLIER up, mixed
// linearly between. The head keeps COLOR_WISP_HEAD.
export const COLOR_WISP_TRAIL_FAST = '#ffd6f5'; // Whitish pink
export const WISP_TRAIL_FAST_AT_MULTIPLIER = 3.0; // the fastest stage's multiplier (STAGE_TABLE)

// Miss feedback (docs/plan.md §6 M5 "ミス時の簡易フィードバック"): the
// marker blinks (alternates hidden/visible) every MISS_BLINK_INTERVAL_TICKS
// ticks for as long as the post-miss grace period (MISS_GRACE_TICKS) lasts.
export const MISS_BLINK_INTERVAL_TICKS = 6;

// Effects (docs/plan.md §3.8): Web Audio SE generated at runtime — no audio
// asset files. Frequencies in Hz, durations in seconds, gains as linear
// [0,1] envelope peaks (kept low since several can overlap the same frame).
export const SFX_MASTER_GAIN = 0.25;
// How loud each sound is, as a tier and a share of it (src/audio/sfxLevels.ts):
// a tier's value is the peak of its loudest sound, and the tiers run from the
// most important moment down — the split, then claims / misses / clears /
// GAME OVER, then the warnings, then the enemies appearing, then the drone
// while drawing. Starting values: the debug panel's SOUND section tunes them
// by ear.
export const SFX_LEVEL_SPLIT = 0.36;
export const SFX_LEVEL_IMPACT = 0.28;
export const SFX_LEVEL_WARNING = 0.2;
export const SFX_LEVEL_ENEMY = 0.13;
export const SFX_LEVEL_DRAW = 0.04;
export const SFX_DRAW_FREQ_FAST = 220;
export const SFX_DRAW_FREQ_SLOW = 130;
// The miss: a falling sawtooth that peaks at once (SFX_IMPACT_ATTACK). Its
// envelope plus SFX_TONE_STOP_TAIL stays within 0.35s. A quieter sawtooth an
// octave up (SFX_MISS_OVERTONE_FREQ) falls with it over the same time, so the
// miss is still heard on a laptop or phone speaker that cannot play 90 Hz.
export const SFX_MISS_FREQ = 90;
export const SFX_MISS_OVERTONE_FREQ = SFX_MISS_FREQ * 2;
export const SFX_MISS_DURATION = 0.33;
export const SFX_STAGE_CLEAR_NOTES = [523, 659, 784, 1047]; // C5 E5 G5 C6 arpeggio
// Both clear arpeggios peak at once (SFX_IMPACT_ATTACK) with short notes, so
// they ring briefly after the moment instead of trailing over the next one.
export const SFX_STAGE_CLEAR_NOTE_DURATION = 0.11;
export const SFX_SPLIT_CLEAR_NOTES = [784, 988, 1175, 1568, 1976]; // brighter/longer — a "special" clear
export const SFX_SPLIT_CLEAR_NOTE_DURATION = 0.09;
export const SFX_IGNITER_SPAWN_FREQ = 340;
export const SFX_IGNITER_SPAWN_DURATION = 0.1;
export const SFX_IGNITER_APPROACH_FREQ = 500;
export const SFX_IGNITER_APPROACH_DURATION = 0.05;
// An Ember spawning: a short square-wave blip held high enough to be heard on
// a laptop or phone speaker — the enemy tier is quiet, and a low, round tone
// there was lost on small speakers.
export const SFX_EMBER_SPAWN_FREQ = 520;
export const SFX_EMBER_SPAWN_DURATION = 0.1;
// A short descending "pop" for an Ember despawning after losing its BORDER
// footing (docs/plan.md §6 M11 / §12.6): a triangle falling from
// SFX_EMBER_DESPAWN_FREQ to SFX_EMBER_DESPAWN_END_FREQ, so it reads as going
// away where the spawn blip holds its pitch. It starts high enough to be
// heard on small speakers, and stays clear of the 880 / 1320 Hz time warning
// beeps and the 1047 Hz claim hit.
export const SFX_EMBER_DESPAWN_FREQ = 620;
export const SFX_EMBER_DESPAWN_END_FREQ = 250;
export const SFX_EMBER_DESPAWN_DURATION = 0.1;
// A sharper one-shot for a Blaze spawning (docs/plan.md §14 M6-1
// "通常スポーン音より鋭い音") — a sawtooth, shorter than SFX_EMBER_SPAWN_*'s
// square and at its own pitch, so the two spawn sounds are clearly
// distinguishable.
export const SFX_EMBER_BLAZE_SPAWN_FREQ = 420;
export const SFX_EMBER_BLAZE_SPAWN_DURATION = 0.07;
// A short 2-note alarm blip for the instant a Blaze steps from BORDER onto
// LINE (docs/plan.md §14 M6-1 "危険が伝わる短いアラーム"), played via the
// existing playArpeggio() mechanism (see SFX_STAGE_CLEAR_NOTES et al.) —
// no new audio machinery needed.
export const SFX_EMBER_ENTERED_LINE_NOTES = [880, 660];
export const SFX_EMBER_ENTERED_LINE_NOTE_DURATION = 0.05;
// How quickly a one-shot reaches its peak (seconds). The default keeps the
// older one-shots as they were; the claim, split and miss sounds hit their
// peak almost at once so the moment itself is felt, not a swell after it.
export const SFX_DEFAULT_ATTACK = 0.01;
export const SFX_IMPACT_ATTACK = 0.004; // within 5ms
// Area claim (audio/sfx.ts's playClaim()): a short bright hit, a low layer
// for a mid-size (around 220 Hz) or large (around 110 Hz) claim, then a
// rising sweep while the new area fills in. The hit and the low layer end
// within 0.08s (their nodes stop SFX_TONE_STOP_TAIL later, already silent).
export const SFX_CLAIM_HIT_FREQ = 1047; // C6, between the 880 / 1320 Hz time warning beeps
export const SFX_CLAIM_HIT_DURATION = 0.05;
export const SFX_CLAIM_LOW_MID_FREQ = 220;
export const SFX_CLAIM_LOW_LARGE_FREQ = 110;
export const SFX_CLAIM_LOW_DURATION = 0.06;
export const SFX_CLAIM_RISE_FREQ_START = 440;
export const SFX_CLAIM_RISE_FREQ_END_FAST = 880;
export const SFX_CLAIM_RISE_FREQ_END_SLOW = 1175; // a slow (double-score) line rises further
export const SFX_CLAIM_RISE_DURATION = 0.2;
// Split clear (playSplitImpact()): a low, short thump, then the split
// arpeggio (SFX_SPLIT_CLEAR_NOTES) right after it.
export const SFX_SPLIT_IMPACT_FREQ = 70;
export const SFX_SPLIT_IMPACT_DURATION = 0.1;
// Every one-shot oscillator is stopped this long after its envelope ends.
export const SFX_TONE_STOP_TAIL = 0.02;
// GAME OVER (playGameOver()): a low falling hit, then three notes resolving
// upward — a close, not a sad fall. Life lost: G4 B4 D5; time up: E4 G#4 B4.
export const SFX_GAMEOVER_HIT_FREQ = 110;
export const SFX_GAMEOVER_HIT_DURATION = 0.12;
export const SFX_GAMEOVER_LIFE_NOTES = [392, 494, 587];
export const SFX_GAMEOVER_TIME_NOTES = [330, 415, 494];
export const SFX_GAMEOVER_NOTE_DURATION = 0.1;
// The GAME OVER score count-up: a short tick while it counts, two notes when
// it stops. Pitches clear of the time warning beeps (880 / 1320 Hz) and the
// claim hit (1047 Hz).
export const SFX_COUNT_TICK_FREQ = 1175; // D6
export const SFX_COUNT_TICK_DURATION = 0.03;
export const SFX_COUNT_END_NOTES = [784, 1175]; // G5 D6
export const SFX_COUNT_END_NOTE_DURATION = 0.06;
// A beaten best: a bright five-note fanfare.
export const SFX_NEW_RECORD_NOTES = [659, 784, 988, 1319, 1568]; // E5 G5 B5 E6 G6
export const SFX_NEW_RECORD_NOTE_DURATION = 0.08;
// How many sounds the engine's own record keeps (SfxEngine.getLog()).
export const SFX_LOG_MAX = 64;

// The background music (src/audio/bgm.ts, src/audio/bgmScore.ts): plays in
// live play while the sound is on, one of three tunes a stage in turn —
// stage 1 the first, 2 the second, 3 the third, 4 the first again.
export const BGM_TRACK_ORDER = ['tense', 'acid', 'hunt'] as const;
// Each tune's own gain under the master (the debug panel's BGM slider scales
// all three by the same factor). The levels of a tune's notes under it are
// part of the tune (src/audio/bgmScore.ts).
export const BGM_GAIN_TENSE = 0.2;
export const BGM_GAIN_ACID = 0.18;
export const BGM_GAIN_HUNT = 0.18;
// Each tune's tempo, and the faster one from BGM_RUSH_FROM_SEC left.
export const BGM_TEMPO = {
  tense: { bpm: 126, rushBpm: 140 },
  acid: { bpm: 130, rushBpm: 144 },
  hunt: { bpm: 170, rushBpm: 178 },
} as const;
export const BGM_RUSH_FROM_SEC = 30;
// The intensity (0-3) rises one step at each of these seconds left: 180-135s
// is 0, 135-90s is 1, 90-30s is 2, 30s and below is 3.
export const BGM_INTENSITY_FROM_SEC = [135, 90, 30] as const;
// Notes are scheduled on the audio clock this far ahead of now.
export const BGM_LOOKAHEAD_SEC = 0.2;
// How long a stopped play-through fades out (seconds): quickly for a pause,
// the switch, mute, a replay or Title; longer at GAME OVER, under its close.
export const BGM_FADE_SEC = 0.05;
export const BGM_GAMEOVER_FADE_SEC = 0.3;

// Impact feedback (src/fx/): the short pause ("hit stop"), the fill reveal,
// the score popup, flashes, shakes and shards that answer an area claim, a
// split and a miss. Every duration is in fixed ticks (TICK_RATE per second),
// never rendered frames, so they last the same on any display. Shake
// amplitudes are in canvas logical pixels (CANVAS_WIDTH x CANVAS_HEIGHT).
// These are the starting values of src/fx/params.ts's fxParams, which the
// debug panel can change at run time.
export interface FxShakeSpec {
  ticks: number;
  amplitudePx: number;
  axes: 'y' | 'xy';
}
// A claim's size is the occupancy it added (after - before): below MID is
// small, from MID is mid, from LARGE is large.
export const FX_CLAIM_SHARE_MID = 0.05;
export const FX_CLAIM_SHARE_LARGE = 0.2;
export const FX_HITSTOP_CLAIM_SMALL_TICKS = 3;
export const FX_HITSTOP_CLAIM_MID_TICKS = 6;
export const FX_HITSTOP_CLAIM_LARGE_TICKS = 10;
export const FX_HITSTOP_SPLIT_TICKS = 20;
export const FX_HITSTOP_MISS_TICKS = 12;
export const FX_LINE_FLASH_TICKS = 6; // the closed line glows white, fading back
export const FX_FILL_REVEAL_TICKS = 12; // newly claimed cells appear outward from the line
export const FX_POPUP_TICKS = 40; // "+score" floats up and fades
export const FX_SHAKE_SMALL: FxShakeSpec = { ticks: 6, amplitudePx: 2, axes: 'y' }; // large claim
export const FX_SHAKE_MEDIUM: FxShakeSpec = { ticks: 10, amplitudePx: 4, axes: 'xy' }; // miss
export const FX_SHAKE_LARGE: FxShakeSpec = { ticks: 16, amplitudePx: 6, axes: 'xy' }; // split
export const FX_MISS_FLASH_TICKS = 4; // first half light, second half dark
export const FX_SHARD_TICKS = 20; // the vanished line breaks into shards
export const FX_SPLIT_BANNER_TICKS = 60; // "SPLIT!"
export const FX_SPLIT_FLASH_TICKS = 12; // the closed line, extended to the field edges, flashes white
export const FX_SPLIT_CONFIRM_LOCK_TICKS = 40; // confirm is not passed on after a split
export const FX_MULTIPLIER_FLY_TICKS = 40; // the next multiplier travels to the HUD
export const FX_MULTIPLIER_HIGHLIGHT_TICKS = 20; // then the HUD multiplier is highlighted
export const FX_GAMEOVER_HOLD_TICKS = 32; // after a game-ending miss: modal waits, confirm is not passed on
// From this added occupancy a claim is praised AWESOME! (from MID it is NICE!,
// from LARGE GREAT!). Only the praise word reads it; the claim size used for
// the hit stop, shake and sound stays small / mid / large.
export const FX_CLAIM_SHARE_HUGE = 0.3;
// The text's glitch (src/fx/textGlitch.ts): SPLIT! tears apart for its first
// BANNER ticks, the score popup and the travelling multiplier split their
// colours for their first POPUP ticks.
export const FX_TEXT_GLITCH_BANNER_TICKS = 9;
export const FX_TEXT_GLITCH_POPUP_TICKS = 6;
// The score popup (and its praise word) appears this much larger and eases
// back to its normal size by the end of BOUNCE_TICKS.
export const FX_POPUP_BOUNCE_SCALE = 1.4;
export const FX_POPUP_BOUNCE_TICKS = 8;
// Sparks from the closed line on every claim: up to MAX cells picked evenly
// along the line, one spark each, flying DISTANCE cells across the line over
// TICKS ticks while fading out.
export const FX_SPARK_MAX = 24;
export const FX_SPARK_TICKS = 16;
export const FX_SPARK_DISTANCE_CELLS = 5;
// Claims in a row: a claim within WINDOW ticks of the previous one adds one
// to the chain (shown as CHAIN xN from 2). Each step raises the claim sound
// by two semitones, up to PITCH_MAX_STEPS steps. Display and sound only.
export const FX_CHAIN_WINDOW_TICKS = 180;
export const FX_CHAIN_PITCH_MAX_STEPS = 6;
// The HUD's score counts up to the real score over this many ticks.
export const FX_SCORE_ROLL_TICKS = 18;
// The goals, the retry and the stage result (presentation only, like the
// impact feedback above; the tick values and the text size start
// src/fx/params.ts's fxParams, which the debug panel can change).
// The HUD multiplier is emphasised for this many ticks after it rises (cyan)
// or falls back to x1 (warning colour).
export const HUD_MULTIPLIER_EMPHASIS_TICKS = 24;
// The HUD multiplier is always drawn this much larger (a transform, so the
// line keeps its height), and up to EXTRA more at the start of its emphasis.
export const HUD_MULTIPLIER_BASE_SCALE = 1.15;
export const HUD_MULTIPLIER_EMPHASIS_EXTRA_SCALE = 0.35;
// The occupancy gauge between the HUD and the field: its height in CSS px,
// and how close to the goal (in percentage points) it turns brighter.
export const HUD_GAUGE_HEIGHT_PX = 4;
export const HUD_GAUGE_NEAR_GOAL_POINTS = 10;
export const HUD_GAUGE_TRACK_COLOR = 'rgba(255, 255, 255, 0.14)';
export const HUD_GAUGE_FILL_COLOR = 'rgba(0, 255, 65, 0.55)';
export const HUD_GAUGE_NEAR_COLOR = '#b6ffc8';
export const HUD_GAUGE_GOAL_COLOR = '#ffffff';
// The STAGE CLEAR result (AREA / BONUS / TOTAL) counts up over this many ticks.
export const STAGE_RESULT_ROLL_TICKS = 30;
// GAME OVER: the keyboard and the field wait at most this many ticks for the
// ranking check (/api/ranking) before they can start the next run again.
export const RETRY_OFFER_WAIT_MAX_TICKS = 90;
// GAME OVER: confirm from the keyboard, the field and the touch buttons is
// dropped for this many ticks from the modal appearing.
export const RETRY_CONFIRM_GUARD_TICKS = 24;
// A field shorter than COMPACT CSS px gets the GAME OVER modal's tighter
// spacing, and one shorter than TINY (a phone held sideways) its tiny layout
// (src/ui/gameOverModal.ts's setDensity()).
export const GAMEOVER_MODAL_COMPACT_BELOW_PX = 400;
export const GAMEOVER_MODAL_TINY_BELOW_PX = 200;
// The GAME OVER result (src/gameOverResult.ts), in live ticks from the modal
// appearing: the score counts up from 0 (ease-out) over
// GAMEOVER_COUNT_TICKS with a tick sound every GAMEOVER_COUNT_TICK_EVERY,
// then pops (GAMEOVER_POP_SCALE back to 1 over GAMEOVER_POP_TICKS); the run's
// highlight follows GAMEOVER_HIGHLIGHT_DELAY_TICKS later, and NEW RECORD (with
// GAMEOVER_SPARK_COUNT sparks for GAMEOVER_SPARK_TICKS) or the distance to the
// best GAMEOVER_RECORD_DELAY_TICKS later. A distance within
// GAMEOVER_NEAR_BEST_RATIO of the best glows like NEW RECORD. None of it holds
// the retry: confirm works as soon as RETRY_CONFIRM_GUARD_TICKS have passed.
export const GAMEOVER_COUNT_TICKS = 42;
export const GAMEOVER_COUNT_TICK_EVERY = 4;
export const GAMEOVER_POP_TICKS = 8;
export const GAMEOVER_POP_SCALE = 1.25;
export const GAMEOVER_HIGHLIGHT_DELAY_TICKS = 6;
export const GAMEOVER_RECORD_DELAY_TICKS = 12;
export const GAMEOVER_SPARK_TICKS = 30;
export const GAMEOVER_SPARK_COUNT = 12;
export const GAMEOVER_NEAR_BEST_RATIO = 0.1;
// The ranking submission panel opens this many live ticks after the GAME OVER
// result's last line (the best line) is due — counted from when it is due,
// also for a run with no best line, from the modal appearing under reduced
// motion — so the result is read before the panel covers it. A ranking reply
// that comes later opens it at once.
export const RANKING_OFFER_DELAY_TICKS = 90;
// How far a GAME OVER spark travels from the NEW RECORD line (CSS px).
export const GAMEOVER_SPARK_DISTANCE_PX = 26;
// The effects' text (+score, praise, CHAIN xN) is never drawn smaller than
// this many CSS px on screen, however far the field is scaled down.
export const FX_TEXT_MIN_DISPLAY_PX = 11;
// The miss reason (WISP HIT YOUR LINE, STOPPED TOO LONG, ...): shown next to
// the contact for TICKS ticks from the miss — through the miss hit stop and
// after it — fading out over its last FADE_TICKS, and never drawn smaller
// than MIN_DISPLAY_PX CSS px on screen. A reading text, so it does not move.
export const FX_MISS_REASON_TICKS = 60;
// The stage's title (STAGE n and its name, config.ts's STAGE_TABLE) over the
// field when a stage starts, for this many ticks. Play does not wait for it.
export const FX_STAGE_TITLE_TICKS = 60;
// BIG CLAIM / CLOSE CALL +N next to a claim's score, for this many ticks.
export const FX_CLAIM_TAG_TICKS = 50;
// Their colours: gold for a big claim, hot orange for a close call — apart
// from the praise words' and SPLIT!'s magenta and cyan neon.
export const COLOR_FX_BIG_CLAIM = '#ffd23f';
export const COLOR_FX_CLOSE_CALL = '#ff8a3d';
export const FX_MISS_REASON_FADE_TICKS = 12;
export const FX_MISS_REASON_MIN_DISPLAY_PX = 13;
// Its colour: the warning red, lighter so it reads on the dark field, edged
// in COLOR_FX_OUTLINE so it reads on a claimed area as well.
export const COLOR_FX_MISS_REASON = '#ff6b6b';
// The effects' text: a geometric display face bundled with the game
// (public/fonts/), falling back to monospace until it has loaded or if it
// cannot be loaded.
export const FX_TEXT_FONT_FAMILY = '"Orbitron", monospace';
// The Japanese sentences (directions, notices, status and error lines, the
// miss reason): the device's own Japanese fonts — none is bundled — falling
// back to monospace. English text keeps its fonts.
export const JA_TEXT_FONT_FAMILY = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", "Meiryo", monospace';
export const COLOR_FX_NEON_CYAN = '#37e6ff';
export const COLOR_FX_NEON_MAGENTA = '#ff2bd6';
export const COLOR_FX_NEON_CORE = '#ffffff';
export const COLOR_FX_TEXT_FILL = '#eaffff';
// Colors of the impact feedback layer (src/render/fxLayer.ts).
export const COLOR_FX_FLASH_LIGHT = '#ffffff';
export const COLOR_FX_FLASH_DARK = '#000000';
export const COLOR_FX_OUTLINE = '#0a0e27'; // dark outline keeps popups/SPLIT! readable on any fill
export const COLOR_FX_POPUP = '#ffffff';
export const COLOR_FX_SPLIT = '#ffe066';
// The start cue: as each stage starts, rings close in on the marker so its
// start — which moves from stage 2 — is seen at a glance. Shown for the stage
// title's time (fxParams.stageTitleTicks), as FX_START_CUE_PULSES rings one
// after another, each shrinking from FROM_RADIUS to TO_RADIUS cells while it
// brightens. With reduced motion: one ring of REDUCED_RADIUS cells that
// stays its size and fades out. Always centred on where the marker is when
// the frame is drawn; clipped to the field. Display only.
export const FX_START_CUE_PULSES = 2;
export const FX_START_CUE_FROM_RADIUS_CELLS = 12;
export const FX_START_CUE_TO_RADIUS_CELLS = 2.5;
export const FX_START_CUE_REDUCED_RADIUS_CELLS = 5;
// The ring's alpha at the start of a pulse (it reaches 1 as it lands).
export const FX_START_CUE_MIN_ALPHA = 0.35;
export const FX_START_CUE_LINE_WIDTH_PX = 2.5; // logical canvas px
// The ring's thin white core, as a share of the ring's line width.
export const FX_START_CUE_CORE_WIDTH_RATIO = 1 / 3;
// ...and never thinner than this many CSS px on screen, however far the
// field is scaled down (a phone held sideways shows it at ~0.3x).
export const FX_START_CUE_MIN_LINE_DISPLAY_PX = 2;
export const FX_START_CUE_GLOW_BLUR = 10; // logical canvas px
export const COLOR_FX_START_CUE = COLOR_FX_NEON_CYAN;

// In-play hints (src/hints/): a short line over the field, plus a mark on the
// field or a glowing touch button, the first time a situation comes up.
// Display only — they never touch the input, the run or the score.
// A timed hint (the claimed side, an enemy's first appearance) stays this
// many ticks; the split hint a little longer, being the longest sentence.
export const HINT_TIMED_TICKS = 150;
export const HINT_SPLIT_TICKS = 180;
// The slow-line hint stays until a slow-line claim, or at most this long.
export const HINT_SLOW_MAX_TICKS = 600;
// A timed hint that comes up while another is shown waits its turn; one
// that has waited longer than this is dropped (and shown another time).
export const HINT_QUEUE_MAX_WAIT_TICKS = 300;
// The ring around a hint's target: shown for RING_TICKS from the hint
// appearing, RADIUS cells across the field's own cells.
export const HINT_RING_TICKS = 90;
export const HINT_RING_RADIUS_CELLS = 5;
// The drawing hint's arrow from the marker into the field, in cells.
export const HINT_ARROW_LENGTH_CELLS = 8;
// The hint line fades in and out over this many ticks (not with reduced motion).
export const HINT_FADE_TICKS = 12;
// The hint line's text size (CSS px): the field's on-screen width times
// HINT_BAR_FONT_PER_FIELD_WIDTH, kept between HINT_BAR_FONT_PX and
// HINT_BAR_FONT_MAX_PX, so a wide field (a PC screen) gets a line that reads
// at its scale. On a field shown less than HINT_BAR_COMPACT_BELOW_PX tall,
// the smaller HINT_BAR_FONT_COMPACT_PX.
export const HINT_BAR_FONT_PX = 13;
export const HINT_BAR_FONT_MAX_PX = 18;
export const HINT_BAR_FONT_PER_FIELD_WIDTH = 0.018;
export const HINT_BAR_FONT_COMPACT_PX = 12;
export const HINT_BAR_COMPACT_BELOW_PX = 200;
// On a field shown less than this tall (a phone held sideways, between the
// touch controls) the Title screen's HOW TO PLAY and RANKING buttons shrink
// to this text size and sit in one row along the field's top edge, clear of
// the title text.
export const TITLE_BUTTONS_COMPACT_BELOW_PX = 200;
export const TITLE_BUTTON_COMPACT_FONT_PX = 10;
export const TITLE_BUTTON_COMPACT_PADDING = '2px 6px';
// Their room from the field's edges and from each other (CSS px).
export const TITLE_BUTTON_COMPACT_INSET_PX = 4;
// With the small buttons, the Title screen's text sits this much lower than
// the field's middle (CSS px), clear of them.
export const TITLE_TEXT_COMPACT_OFFSET_PX = 12;
// The Title screen's demo: a top-ranked run's replay played silently behind
// the title text (src/titleDemo.ts). It starts this many ticks after the
// Title screen appears, trying at most this many of the board's best replays
// (one fetch each, kept for the page), and holds a finished run's last board
// this many ticks before playing it again from the start.
export const TITLE_DEMO_START_DELAY_TICKS = 60;
export const TITLE_DEMO_MAX_CANDIDATES = 3;
export const TITLE_DEMO_END_HOLD_TICKS = 120;
// The demo board is drawn under a veil of the background color (COLOR_BACKGROUND)
// at this opacity, so the title text and the buttons over it stay readable.
export const TITLE_DEMO_DIM_ALPHA = 0.55;
// The DEMO tag in the field's bottom-left corner: its text size (CSS px), the
// smaller size on a field shown less than TITLE_BUTTONS_COMPACT_BELOW_PX tall,
// and its distance from the field's left and bottom edges for each. On the
// small field the title text, lowered by TITLE_TEXT_COMPACT_OFFSET_PX and
// wrapped to the field's width, leaves only about the tag's own height below
// it, so the small tag sits on the field's bottom edge.
export const TITLE_DEMO_LABEL_FONT_PX = 12;
export const TITLE_DEMO_LABEL_FONT_COMPACT_PX = 10;
export const TITLE_DEMO_LABEL_INSET_PX = 8;
export const TITLE_DEMO_LABEL_INSET_COMPACT_PX = 4;
export const TITLE_DEMO_LABEL_BOTTOM_COMPACT_PX = 0;
// After HOW TO PLAY closes, confirms (keys, a tap on the field, the touch
// buttons) are dropped for this many ticks, so the key that closed it does
// not also start a run.
export const HOW_TO_CLOSE_GUARD_TICKS = 12;
// The pause (src/pause.ts): the touch PAUSE button's and the pause screen's
// RESUME button's smallest pressable side (CSS px).
export const PAUSE_BUTTON_MIN_SIZE_PX = 44;
// The pause screen's PAUSED heading and its resume hint (CSS px), and their
// smaller sizes on a field shown less than PAUSE_OVERLAY_COMPACT_BELOW_PX
// tall, where the heading, RESUME and the hint must all still fit.
export const PAUSE_OVERLAY_TITLE_FONT_PX = 28;
export const PAUSE_OVERLAY_TITLE_FONT_COMPACT_PX = 16;
export const PAUSE_OVERLAY_HINT_FONT_PX = 13;
export const PAUSE_OVERLAY_HINT_FONT_COMPACT_PX = 11;
export const PAUSE_OVERLAY_COMPACT_BELOW_PX = 200;

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

// Wisp head, drawn as a bright core + softer halo circle (~4x4 cells across).
// Only the head's own cell hits, so the drawn head is larger than what can
// hit, never smaller. The afterimage trail behind it is per-cell fillRect
// (see WISP_TRAIL_ALPHA_* above).
export const WISP_HEAD_HALO_RADIUS_CELLS = 2.0;
export const WISP_HEAD_CORE_RADIUS_CELLS = 1.1;
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

// Touch controls (docs/plan.md §5.2): virtual d-pad (left) + FAST/SLOW
// buttons (right), placed below the field in bottom mode or beside it in
// side mode. Pure layout tuning — sizes in CSS pixels.
export const TOUCH_CONTROLS_HEIGHT = 168;
export const TOUCH_BUTTON_SIZE = 64;
export const TOUCH_DPAD_GAP = 4;
// Extend the d-pad hit target without changing its visible 3x3 grid.
export const TOUCH_DPAD_HIT_MARGIN = 16;
// Ignore touches near the d-pad center so an ambiguous press does not move.
export const TOUCH_DPAD_DEAD_ZONE_RADIUS = 16;
export const TOUCH_SIDE_COLUMN_PADDING = 8;
// Vertical padding (CSS px) above and below the bottom-mode control row.
// touch.ts publishes it as --touch-bottom-pad-y for index.html and also uses
// it to estimate the bottom-mode field size.
export const TOUCH_BOTTOM_CONTROLS_PADDING_Y = 10;
// A touch landscape whose center column is at least this wide always uses
// side mode. Narrower touch landscapes compare the estimated field size of
// side and bottom mode and take the larger one (touch.ts's
// resolveTouchLayout()).
export const TOUCH_SIDE_MIN_FIELD_WIDTH = 240;
// Height (CSS px) reserved for the HUD row plus its gap above the field when
// estimating the field size of either touch layout. Measured with a 3-line
// HUD at 16px: the row is 54px in Chromium and 57px in WebKit, plus main.ts's
// 6px HUD_GAP_PX; the taller WebKit value is used.
export const TOUCH_LAYOUT_HUD_RESERVE_HEIGHT = 63;
// In a side layout whose center column is narrower than
// TOUCH_SIDE_MIN_FIELD_WIDTH, the HUD font shrinks so that this many ems fit
// in the column (but never below TOUCH_NARROW_SIDE_HUD_MIN_FONT_SIZE). The
// longest normal-digit HUD line is about 18.7em in a monospace font, and
// two 6-digit scores make it about 19.9em.
export const TOUCH_NARROW_SIDE_HUD_LINE_EM = 20;
export const TOUCH_NARROW_SIDE_HUD_MIN_FONT_SIZE = 10;
export const TOUCH_CONTROLS_OPACITY = 0.55;

// Score ranking: the "rules" a
// recorded/verified replay is judged under. Bumping RULESET_VERSION means
// "an old replay can no longer be trusted to reproduce the same score" (a
// core/game.ts or core/claim.ts balance change, say) — functions/ rejects a
// POST whose client-reported ruleset doesn't match this build's value, and
// the server-side CURRENT_SEASON_ID must be incremented in lockstep whenever
// the rules change. REPLAY_FORMAT_VERSION instead means "the
// *encoding* of a stored replay changed" (e.g. the RLE byte layout below) —
// independent of whether the rules themselves changed, so an old row can
// stay visible on the ranking (its score is still valid) while its replay
// becomes unplayable until re-encoded. Both started at 1 for the
// initial release. Ruleset 2: the per-stage table, big claims, close calls,
// the split reward by the smaller side and the shorter post-miss wait.
export const RULESET_VERSION = 2;
export const REPLAY_FORMAT_VERSION = 1;

// Replay viewing: how long a cleared stage stays on screen, with its
// "STAGE n CLEAR!" overlay, before playback moves on to the next stage by
// itself. Live play waits for a key press at this point; a replay has nobody
// to press one, and advancing on the very next tick left the clear unreadable.
// Purely a viewing pause (src/main.ts's replay driver) — the recorded run,
// its score and its verification are untouched, so this is neither a
// RULESET_VERSION nor a REPLAY_FORMAT_VERSION matter.
export const REPLAY_STAGE_CLEAR_HOLD_SECONDS = 1.5;
export const REPLAY_STAGE_CLEAR_HOLD_TICKS = Math.round(REPLAY_STAGE_CLEAR_HOLD_SECONDS * TICK_RATE); // 90

// InputRecorder: the hard cap
// on recorded PLAYING-tick samples for a single run, matching
// TIME_LIMIT_TICKS exactly — a run can never accumulate more playing ticks
// than its own time budget, so this is a natural (not arbitrary) ceiling.
// Kept as its own named constant (rather than importing TIME_LIMIT_TICKS
// everywhere this cap is checked) so RLE decoders — including the server's
// verifyReplay(), which must reject anything past it as a protocol
// violation rather than just "coincidentally equal to the current time
// limit" — read as self-documenting on their own.
export const MAX_INPUT_SAMPLES = TIME_LIMIT_TICKS;

// Score ranking protocol cap: the server's replay verification rejects a
// replay the instant it detects one area-claim past this limit. It is a
// protocol/DoS parameter bounding audit CPU per row, NOT a gameplay rule
// (core/claim.ts is untouched), which is why it lives here rather than under
// RULESET_VERSION's scope. Changing it is documented (docs/ranking-runbook.md
// §4.3) as a season/verification-rule change.
//
// Sized from measurement (docs/ranking-cpu-measurement.md §7, harness
// docs/measurements/measure-claim-cap.ts): a deliberately small-notch bot
// already makes ~52 area-claims in a single failed stage-1 attempt, and a
// careful multi-stage run accumulates more, so the earlier value of 100 sat
// close enough to legitimate play to wrongly reject it. 300 clears that with
// margin while keeping the audit bounded — worst-case ~3.8s per row at
// ~12.5ms/claim, a full 200-row pending queue draining in ~3 audit cycles.
// It also sits above the practical per-replay claim ceiling reachable within
// the run-wide 10800-tick budget (reliable notch constructions plateau around
// 230), so within a valid replay it behaves as a backstop rather than a limit
// real play approaches. Raised from 100 before launch, while scores was empty
// (no season bump needed); see the runbook for the post-launch procedure.
export const MAX_VERIFIED_CLAIMS = 300;

// How many rows the ranking board keeps (the TOP 10). The client reads it for
// the HUD's goal slot (src/hudGoal.ts) and the submission offer's
// provisional in-range check (src/ui/ranking.ts).
export const RANKING_BOARD_SIZE = 10;

// The on-device play log (src/playLog/, src/storage/playLog.ts): the finished
// normal runs kept in localStorage for the debug panel's PLAY LOG summary.
// Nothing leaves the device. The newest PLAY_LOG_MAX_RUNS runs are kept; older
// ones are dropped as new ones come in.
export const PLAY_LOG_MAX_RUNS = 50;
// The debug panel's `STREAK ≤ ST<n>`: how many of the newest runs in a row
// ended on this stage or earlier.
export const PLAY_LOG_STREAK_STAGE = 2;
