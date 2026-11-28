// Test support: plays a GameSession on to a given stage quickly, from
// whatever edge each stage's marker starts on (core/markerStart.ts). Used by
// the marker start and Wisp spawn tests, which need many seeds' later stages.
import { GameSession, SessionOptions } from './session';
import { MarkerStartEdge } from './markerStart';
import { Axis } from './marker';

interface Step {
  dx: Axis;
  dy: Axis;
}

const INWARD: Record<MarkerStartEdge, Step> = {
  top: { dx: 0, dy: 1 },
  bottom: { dx: 0, dy: -1 },
  left: { dx: 1, dy: 0 },
  right: { dx: -1, dy: 0 },
};

/**
 * Clears the current stage from its start: with the required occupancy
 * lowered to almost nothing (a debug override, so the run is tainted), a
 * small box drawn straight in from the start, along the edge and back out is
 * enough. The Wisps spawn well away from the start, so the box never reaches
 * them. Throws if the stage did not clear.
 */
export function clearFromStart(session: GameSession): void {
  session.applyDebugOverrides({ requiredOccupancy: 0.00001 });
  const start = session.getMarkerStart();
  if (!start) throw new Error('the stage was built by a gameFactory');
  const inward = INWARD[start.edge];
  const along: Step = inward.dx === 0 ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 };
  const outward: Step = { dx: -inward.dx as Axis, dy: -inward.dy as Axis };
  for (const step of [inward, inward, along, along, outward, outward]) {
    session.update({ ...step, drawHeld: true, slow: false, confirm: false });
  }
  if (session.getStatus() !== 'stageclear') {
    throw new Error(`stage ${session.getStage()} from ${JSON.stringify(start)} did not clear: ${session.getStatus()}`);
  }
}

/** A session played on to the first tick of `stage`, each earlier stage cleared from its start. */
export function sessionAtStage(stage: number, options: SessionOptions): GameSession {
  const session = new GameSession(options);
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  while (session.getStage() < stage) {
    clearFromStart(session);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  }
  if (session.getStatus() !== 'playing' || session.getStageTicks() !== 0) {
    throw new Error(`not at the start of stage ${stage}`);
  }
  return session;
}
