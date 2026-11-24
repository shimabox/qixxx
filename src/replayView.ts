// Replay viewing's side of a tick and of a frame (src/main.ts's
// updateReplay() and renderFrame()), kept apart from main.ts so the path a
// ranking replay takes can be unit tested with a real ReplayEngine.
//
// A replay tick steps the recorded run and drains its queues; it is given
// neither the impact effects nor the sounds, so a replay plays no cue of its
// own (no ring, no surge sound). What the board shows — the Wisp heads in the
// stage's surge level color — comes from the replay session's own game, as
// for live play and the Title demo.
import type { ReplayEngine } from './core/replayEngine';
import type { Game } from './core/game';
import type { GameSession } from './core/session';
import type { FxFrame } from './fx/director';
import type { WispDraw } from './render/renderer';
import type { ReplayStageClearHold } from './replayStageClearHold';

/**
 * One replay-viewing tick while it plays on its own: steps the engine
 * unless the STAGE CLEAR hold keeps the cleared stage on screen, and drains
 * (forwards nowhere) the session's event queues. False once the recorded
 * input has run out.
 */
export function stepReplayView(engine: ReplayEngine, hold: ReplayStageClearHold): boolean {
  const replaySession = engine.getSession();
  const holding = hold.shouldHold({
    status: replaySession.getStatus(),
    finished: engine.isFinished(),
  });
  if (holding) return true;
  const advanced = engine.stepTick();
  // Drain (not forward anywhere) every tick, same as a live run —
  // GameSession's own doc comments warn these queues grow unbounded
  // otherwise.
  replaySession.drainEvents();
  replaySession.drainDespawnedEmberPositions();
  return advanced;
}

/**
 * What decides the board on screen (main.ts's state): whether a ranking
 * replay is being viewed, the live run, the ranking replay's engine (null
 * when none is open) and the Title demo.
 */
export interface BoardSources {
  viewMode: 'live' | 'replay';
  live: GameSession;
  replay: ReplayEngine | null;
  titleDemo: { getShownEngine(): ReplayEngine | null };
}

/** The GameSession the HUD reads: the ranking replay's while one is viewed, otherwise the live run's. */
export function activeBoardSession(sources: BoardSources): GameSession {
  return sources.viewMode === 'replay' && sources.replay ? sources.replay.getSession() : sources.live;
}

/**
 * The Title demo's engine whose board is on screen now, or null. Only ever
 * on the live Title screen: the tick that starts a run, or a ranking replay
 * opening between ticks, already shows the board it switches to.
 */
export function shownTitleDemoEngine(sources: BoardSources): ReplayEngine | null {
  if (sources.viewMode !== 'live' || sources.replay !== null || sources.live.getStatus() !== 'title') return null;
  return sources.titleDemo.getShownEngine();
}

/** The Game whose board is drawn: the Title demo's while it shows, otherwise the active session's (activeBoardSession()). */
export function drawnBoardGame(sources: BoardSources): Game {
  const demoEngine = shownTitleDemoEngine(sources);
  return demoEngine ? demoEngine.getSession().getGame() : activeBoardSession(sources).getGame();
}

/**
 * The Wisps to draw for `game`, the board on screen (live, a replay or the
 * Title demo): each Wisp's own speed sets its trail's color, and the stage's
 * surge level its head's.
 */
export function boardWispDraws(game: Game): WispDraw[] {
  return game.getWisps().map((wisp) => ({
    trail: wisp.getTrailRef(),
    speedMultiplier: wisp.getSpeedMultiplier(),
    surgeLevel: game.getWispSurgeLevel(),
  }));
}

/** The impact effects drawn this frame: live play only, so none for a replay. */
export function boardFxFrame(viewMode: 'live' | 'replay', fx: { getFrame(): FxFrame }): FxFrame | null {
  return viewMode === 'replay' ? null : fx.getFrame();
}

/**
 * The impact effects handed to the renderer with the board: `fxFrame`
 * (boardFxFrame()), or none while the Title demo's board is the one shown,
 * so the demo is drawn with no ring, popup or other cue of its own.
 */
export function renderedFxFrame(fxFrame: FxFrame | null, titleDemoShown: boolean): FxFrame | undefined {
  return titleDemoShown ? undefined : fxFrame ?? undefined;
}
