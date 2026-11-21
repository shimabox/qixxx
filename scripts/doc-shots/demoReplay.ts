// A made-up ranking replay for the screenshots: the game's own simulation
// (src/core/) plays a run that sweeps the field in strips — a line down,
// a few steps along the border, a line up — so it claims area, clears
// stages and keeps moving. Recorded with this build's rules, so the page
// accepts and plays it back (src/ui/ranking.ts checks the versions).
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../src/config';

export const DEMO_SEED = 377;

function record(seed: number, maxSamples: number): string {
  const session = new GameSession({ seed });
  const confirm = { dx: 0 as const, dy: 0 as const, drawHeld: false, slow: false, confirm: true };
  session.update(confirm);
  const samples: InputSample[] = [];
  const step = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  };
  const height = session.getGame().getField().getHeight();
  let goingDown = true;
  while (session.getStatus() !== 'gameover' && samples.length < maxSamples) {
    if (session.getStatus() === 'stageclear') {
      session.update(confirm);
      continue;
    }
    const targetY = goingDown ? height - 1 : 0;
    let crossing = 0;
    while (
      session.getStatus() === 'playing' &&
      samples.length < maxSamples &&
      session.getGame().getMarker().getPosition().y !== targetY &&
      crossing++ < height + 5
    ) {
      step(0, goingDown ? 1 : -1, true);
    }
    for (let i = 0; i < 4 && session.getStatus() === 'playing' && samples.length < maxSamples; i++) step(1, 0, false);
    goingDown = !goingDown;
  }
  return Buffer.from(encodeRle(samples)).toString('base64');
}

/** The body of GET /api/ranking/{id}/replay. */
export function demoReplayPayload(maxSamples = 3000): string {
  return JSON.stringify({
    seed: DEMO_SEED,
    rleBase64: record(DEMO_SEED, maxSamples),
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
  });
}
