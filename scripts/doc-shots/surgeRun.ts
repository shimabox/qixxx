// The pictures from stage 3 on: an ordinary NORMAL run, no debug override,
// that plays the input of the core's surge run (src/core/surgeRunFixture.ts,
// seed SURGE_RUN_SEED). Stages 1 and 2 are cleared on occupancy, stages 3,
// 4 and 5 by splitting the Wisps, and on stage 6 two claims raise the Wisp
// surge to level 1 and then to level 2.
//
// The page's own loop runs every tick (its drawing, effects and hit stops);
// only the input a playing tick hands the session is the recorded one, one
// sample per session.update() call, so the run plays out as it was recorded
// whatever the frames' timing. The recording holds play ticks only: the
// Title start and each STAGE CLEAR are confirmed with a key here, as a
// player would, once the clear screen has been shown for a while.
import type { Page } from '@playwright/test';
import { playSurgeRun, SURGE_RUN_SEED } from '../../src/core/surgeRunFixture';
import type { InputSample } from '../../src/core/rle';
import { FRAME_MS, probe, type Probe } from './page';
import { wait } from './actions';

export { SURGE_RUN_SEED };

let recorded: InputSample[] | null = null;
const samples = (): InputSample[] => (recorded ??= playSurgeRun().samples);

/**
 * Hands the live session the recorded samples, one per call while it is
 * playing. Every other call (Title, STAGE CLEAR, GAME OVER, or once the
 * samples have run out) gets the page's own input.
 */
export async function installSurgeRun(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const samples = ${JSON.stringify(samples())};
    const s = window.__game__.session;
    const update = s.update.bind(s);
    let next = 0;
    s.update = (input) => {
      if (s.getStatus() !== 'playing' || next >= samples.length) return update(input);
      const q = samples[next++];
      return update({ dx: q.dx, dy: q.dy, drawHeld: q.drawHeld, slow: q.slow, confirm: false });
    };
    return true;
  })()`);
}

/** STAGE CLEAR confirmed with a key: the first press may only finish the count-up. */
async function confirmStageClear(page: Page, stage: number): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Space');
    await wait(page, 100);
    const p = await probe(page);
    if (p.status === 'playing' && p.stage === stage + 1) return;
  }
  throw new Error(`stage ${stage + 1} did not start`);
}

/**
 * Plays the surge run frame by frame until `stop` holds, confirming every
 * STAGE CLEAR `stop` does not stop on after 2 seconds of it. Fails if the
 * run loses a life or ends on the way.
 */
export async function playSurgeRunTo(page: Page, stop: (p: Probe) => boolean, what: string): Promise<Probe> {
  for (let elapsed = 0; elapsed < 120_000; elapsed += FRAME_MS) {
    const p = await probe(page);
    if (stop(p)) return p;
    if (p.status === 'stageclear') {
      await wait(page, 2_000);
      await confirmStageClear(page, p.stage);
      continue;
    }
    if (p.status !== 'playing' || p.lives !== 3) throw new Error(`${what}: the surge run went off its course: ${JSON.stringify(p)}`);
    await page.clock.runFor(FRAME_MS);
  }
  throw new Error(`${what}: not reached`);
}
