// Test support: drives a seeded GameSession through a fixed, scripted input
// list and summarizes the outcome. Used by the rule-invariance tests, which
// pin the summary for a fixed seed so any change that alters the simulation
// (score, stages reached, lives, claims, board, elapsed ticks) is caught.
//
// The script is a pure function of the stage's marker start and the tick
// index inside the stage: it never reads the board, and a seed's starts are
// fixed, so the inputs fed to the session are the same list on every run. A StageClear is confirmed on its own tick, the same way
// a replay is driven (core/replayEngine.ts).
import { GameSession, SessionInput, SessionOptions } from './session';
import { Field, Point } from './field';
import { GameEvent } from './events';
import { Axis } from './marker';

interface Segment {
  dx: Axis;
  dy: Axis;
  drawHeld: boolean;
  slow: boolean;
  ticks: number;
}

/**
 * The border walk from the marker's start to (`firstX`, 0) on the top edge:
 * along the top edge from a top start; up the side and along the top from a
 * left or right start; along the bottom to the bottom-left corner, up the
 * left edge and along the top from a bottom start.
 */
function walkToTopEdge(width: number, height: number, start: Point, firstX: number): Segment[] {
  const walk = (dx: Axis, dy: Axis, ticks: number): Segment => ({ dx, dy, drawHeld: false, slow: false, ticks });
  if (start.y === 0) {
    return [start.x >= firstX ? walk(-1, 0, start.x - firstX) : walk(1, 0, firstX - start.x)];
  }
  if (start.y === height - 1) {
    return [walk(-1, 0, start.x), walk(0, -1, height - 1), walk(1, 0, firstX)];
  }
  if (start.x === 0) {
    return [walk(0, -1, start.y), walk(1, 0, firstX)];
  }
  return [walk(0, -1, start.y), walk(-1, 0, width - 1 - firstX)];
}

/**
 * One stage's script on a `width` x `height` field: walk the border from the
 * marker's `start` (the stage's start; the middle of the top edge by
 * default) to near the top-left corner, then comb the field with vertical
 * lines from top to bottom and back, stepping right along the border
 * between them. Every third line is drawn slow. Each line closes on the
 * opposite border and claims the strip on the side without a Wisp (or
 * splits the Wisps apart). From the default start the walk is the same one
 * the script has always made: straight left along the top.
 */
export function buildStageScript(width: number, height: number, start: Point = { x: Math.floor(width / 2), y: 0 }): Segment[] {
  const firstX = 3;
  const spacing = 3;
  const segments: Segment[] = walkToTopEdge(width, height, start, firstX);
  let goingDown = true;
  let line = 0;
  for (let x = firstX; x < width - 2; x += spacing) {
    const slow = line % 3 === 2;
    const cells = height - 1;
    segments.push({ dx: 0, dy: goingDown ? 1 : -1, drawHeld: true, slow, ticks: slow ? cells * 2 : cells });
    segments.push({ dx: 1, dy: 0, drawHeld: false, slow: false, ticks: spacing });
    goingDown = !goingDown;
    line++;
  }
  // Idle on the border for the rest of the stage.
  segments.push({ dx: 0, dy: 0, drawHeld: false, slow: false, ticks: Number.POSITIVE_INFINITY });
  return segments;
}

function inputAt(segments: readonly Segment[], tick: number): SessionInput {
  let remaining = tick;
  for (const s of segments) {
    if (remaining < s.ticks) {
      return { dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false };
    }
    remaining -= s.ticks;
  }
  return { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };
}

/** FNV-1a over every cell state, row-major. */
export function hashField(field: Field): string {
  let h = 0x811c9dc5;
  for (let y = 0; y < field.getHeight(); y++) {
    for (let x = 0; x < field.getWidth(); x++) {
      h ^= field.getAt(x, y);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

/** FNV-1a over an event list, so a whole run's event order can be compared as one value. */
export function hashEvents(events: readonly GameEvent[]): string {
  let h = 0x811c9dc5;
  for (const ev of events) {
    for (let i = 0; i < ev.length; i++) {
      h ^= ev.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface StageSummary {
  stage: number;
  score: number;
  lives: number;
  /** Total ticks of the run at the end of this stage. */
  totalTicks: number;
  fieldHash: string;
  split: boolean;
}

export interface ScriptedRunSummary {
  score: number;
  stage: number;
  lives: number;
  claims: number;
  misses: number;
  splits: number;
  totalTicks: number;
  status: string;
  gameOverReason: string | null;
  fieldHash: string;
  eventsHash: string;
  stages: StageSummary[];
}

export interface ScriptedRunOptions extends SessionOptions {
  /** Called after every session.update() of a playing tick, before events are drained. */
  onTick?: (session: GameSession) => void;
}

/**
 * Runs the scripted input list against a fresh session until gameover (or
 * `maxTicks` playing ticks), and returns the summary.
 */
export function runScriptedSession(options: ScriptedRunOptions, maxTicks = 20000): ScriptedRunSummary {
  const { onTick, ...sessionOptions } = options;
  const session = new GameSession(sessionOptions);
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const width = sessionOptions.fieldWidth ?? session.getGame().getField().getWidth();
  const height = sessionOptions.fieldHeight ?? session.getGame().getField().getHeight();
  // Rebuilt as each stage starts, from that stage's marker start.
  let script = buildStageScript(width, height, session.getMarkerStart()?.point);
  let scriptStage = session.getStage();

  const events: GameEvent[] = [];
  const stages: StageSummary[] = [];
  let claims = 0;
  let misses = 0;
  let splits = 0;
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard < maxTicks) {
    guard++;
    if (session.getStatus() === 'stageclear') {
      stages.push({
        stage: session.getStage(),
        score: session.getScore(),
        lives: session.getLives(),
        totalTicks: session.getTotalTicks(),
        fieldHash: hashField(session.getGame().getField()),
        split: session.getGame().getLastClearWasSplit(),
      });
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
      continue;
    }
    if (session.getStage() !== scriptStage) {
      script = buildStageScript(width, height, session.getMarkerStart()?.point);
      scriptStage = session.getStage();
    }
    session.update(inputAt(script, session.getStageTicks()));
    onTick?.(session);
    for (const ev of session.drainEvents()) {
      events.push(ev);
      if (ev === 'area-claimed') claims++;
      if (ev === 'miss') misses++;
      if (ev === 'split-clear') splits++;
    }
    session.drainDespawnedEmberPositions();
  }

  return {
    score: session.getScore(),
    stage: session.getStage(),
    lives: session.getLives(),
    claims,
    misses,
    splits,
    totalTicks: session.getTotalTicks(),
    status: session.getStatus(),
    gameOverReason: session.getGameOverReason(),
    fieldHash: hashField(session.getGame().getField()),
    eventsHash: hashEvents(events),
    stages,
  };
}
