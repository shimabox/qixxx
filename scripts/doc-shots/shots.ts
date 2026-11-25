// Every screenshot in docs/images/ that the script takes: its name, the
// screen it is taken on (size, language, touch), the saved state and the
// made-up ranking it starts from, how the screen is brought to the picture,
// and the part of the page kept. To add or fix a picture, add or fix its
// entry here and run `npm run docs:shots -- <name>`.
//
// The runs are ordinary runs — keys on the faked clock, the seed fixed —
// so the HUD's goal, the high score and the ranking offer read as they
// would for a player. The pictures from stage 3 on play the core's surge
// run's recorded input instead of keys (./surgeRun.ts), still an ordinary
// run. Two pictures change a setting: ember-blaze, a close-up of the field
// with no HUD in it, which shortens the time between Ember pairs, and
// readme-debug, which shows the debug panel's slider being used.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { GRID_HEIGHT, GRID_WIDTH, RULESET_VERSION } from '../../src/config';
import { demoReplayPayload } from './demoReplay';
import { ALL_HINTS, probe, type OpenPage, type PageSetup, type Probe, type RankingEntry, type Viewport } from './page';
import { installSurgeRun, playSurgeRunTo, SURGE_RUN_SEED } from './surgeRun';
import {
  advanceUntilShown,
  cutColumn,
  drawTo,
  drawUntilClosed,
  flushTasks,
  settle,
  startRun,
  stepTimers,
  wait,
  waitFor,
  waitOutGrace,
  walkToX,
} from './actions';

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Shot {
  name: string;
  /** 'dev' for the dev-only debug panel; 'preview' (the production build) otherwise. */
  server: 'preview' | 'dev';
  setup: () => PageSetup;
  prepare: (page: Page, opened: OpenPage) => Promise<void>;
  /** The part of the page kept (CSS px); the whole screen when absent. */
  clip?: (page: Page) => Promise<Clip>;
}

// Screen sizes (CSS px); every picture is taken at device scale 2.
const README: Viewport = { width: 1000, height: 840, touch: false };
const GUIDE: Viewport = { width: 1000, height: 750, touch: false };
const TITLE: Viewport = { width: 900, height: 760, touch: false };
const DEBUG: Viewport = { width: 1280, height: 840, touch: false };
const PORTRAIT: Viewport = { width: 390, height: 844, touch: true };
const LANDSCAPE: Viewport = { width: 844, height: 390, touch: true };

const SAVED_BEST = 18349;

const board = (rows: Array<[string, number, number]>): RankingEntry[] =>
  rows.map(([name, score, stage], i) => ({
    id: `doc${i + 1}`,
    createdAt: `2026-10-${String(20 - i).padStart(2, '0')}T12:00:00Z`,
    score,
    stage,
    name,
    xHandle: null,
    replayAvailable: true,
  }));

/** Made-up names: no real player appears in a picture. Six rows, so any score can still be posted. */
const SHORT_BOARD = board([
  ['NEON_RIDER', 24310, 4],
  ['SLOW_AND_STEADY', 18349, 3],
  ['LINE_WALKER', 15664, 3],
  ['QIX_FAN', 11056, 2],
  ['CORNER_CUTTER', 6593, 2],
  ['STAGE_HUNTER', 4602, 1],
]);

let demoPayload: string | null = null;
const replayPayload = (): string => (demoPayload ??= demoReplayPayload());

function base(viewport: Viewport, over: Partial<PageSetup> = {}): PageSetup {
  return {
    viewport,
    locale: 'en-US',
    seed: 1,
    highScore: SAVED_BEST,
    hintsSeen: ALL_HINTS,
    soundOn: false,
    ranking: 'fail',
    rulesetVersion: RULESET_VERSION,
    ...over,
  };
}

const log = process.argv.includes('--log') ?(...args: unknown[]) => console.log(...args) : () => undefined;

// Every picture checks, just before it is taken, that the screen is in the
// state it is meant to show, and fails rather than take a different one.
function expect(condition: boolean, what: string, state?: Probe): void {
  if (!condition) throw new Error(`${what}${state ? `: ${JSON.stringify(state)}` : ''}`);
}

/** Reads the game's state and fails unless `check` holds on it. */
async function expectState(page: Page, check: (p: Probe) => boolean, what: string): Promise<Probe> {
  const p = await probe(page);
  expect(check(p), what, p);
  return p;
}

/** The run still on, no life lost: nothing went wrong while the picture was waited for. */
const playingFullLives = (p: Probe): boolean => p.status === 'playing' && p.lives === 3 && !p.paused;

/** The GAME OVER result's best line ('to-best', 'to-best-near' or 'new-record'; null while not shown). */
async function gameOverBest(page: Page): Promise<{ best: string | null; highlight: string | null }> {
  return page.evaluate(`(() => { const r = window.__game__.getGameOverResult(); return { best: r.best, highlight: r.highlight }; })()`);
}

const PANEL_SHOWN = `(() => { const p = document.getElementById('how-to-play-panel'); return p !== null && p.getClientRects().length > 0; })()`;

/** HOW TO PLAY opened from the Title screen. */
async function openHowToPlay(page: Page): Promise<void> {
  await page.locator('#how-to-play-button').click();
  await wait(page, 500);
  expect(await page.evaluate<boolean>(PANEL_SHOWN), 'the HOW TO PLAY panel open');
}

// ---- Waiting on the mocked API, the clock stopped --------------------------

async function waitAnswered(page: Page, opened: OpenPage, kind: 'ranking' | 'replay', count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (opened.answered[kind] < count) {
    if (Date.now() > deadline) throw new Error(`no ${kind} answer #${count}`);
    await sleep(20);
  }
  // The answer's body is read and parsed in later tasks of the page.
  await flushTasks(page);
}

/**
 * The Title demo up and playing, then `ms` of it: the board's answer and the
 * replay wait with the clock stopped, and the replay is built over its
 * zero-delay timers, so the demo always starts on the same tick.
 */
async function titleDemo(page: Page, opened: OpenPage, ms: number): Promise<void> {
  await waitAnswered(page, opened, 'ranking', 1);
  await waitFor(page, (p) => p.demoState !== 'waiting', 3_000, 'the demo leaves waiting');
  await waitAnswered(page, opened, 'replay', 1);
  await stepTimers(page, `window.__game__.getTitleDemo().state === 'playing'`, 'the demo is built');
  await wait(page, ms);
  await expectState(page, (p) => p.status === 'title' && p.demoState === 'playing' && p.demoShown, 'the Title demo playing');
}

/** RANKING opened on the Title screen and its rows drawn. */
async function openRanking(page: Page, opened: OpenPage): Promise<void> {
  await waitAnswered(page, opened, 'ranking', 1);
  await page.locator('#ranking-button').click();
  await waitAnswered(page, opened, 'ranking', 2);
  await settle(page, `document.querySelectorAll('#ranking-list-body button').length > 0`, 'ranking rows');
  await wait(page, 200);
}

// ---- Field geometry ----------------------------------------------------------

/** The page box of the field cells from (x0, y0) to (x1, y1), grown by `pad` CSS px. */
async function fieldClip(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<Clip> {
  const r = await page.evaluate<{ left: number; top: number; width: number; height: number }>(
    `(() => { const r = document.getElementById('game-canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`
  );
  const cw = r.width / GRID_WIDTH;
  const ch = r.height / GRID_HEIGHT;
  return { x: r.left + x0 * cw, y: r.top + y0 * ch, width: (x1 - x0) * cw, height: (y1 - y0) * ch };
}

/** A clip of `w`×`h` CSS px centred on field cell `at`, kept inside the field. */
async function clipAround(page: Page, at: { x: number; y: number }, w: number, h: number): Promise<Clip> {
  const field = await fieldClip(page, 0, 0, GRID_WIDTH, GRID_HEIGHT);
  const cx = field.x + ((at.x + 0.5) * field.width) / GRID_WIDTH;
  const cy = field.y + ((at.y + 0.5) * field.height) / GRID_HEIGHT;
  const x = Math.round(Math.min(Math.max(cx - w / 2, field.x - 8), field.x + field.width + 8 - w));
  const y = Math.round(Math.min(Math.max(cy - h / 2, field.y - 8), field.y + field.height + 8 - h));
  return { x, y, width: w, height: h };
}

/** The HUD row and the occupancy gauge under it, across the screen. */
async function hudClip(page: Page): Promise<Clip> {
  const box = await page.evaluate<{ top: number; bottom: number; width: number }>(
    `(() => { const row = document.getElementById('hud-row').getBoundingClientRect(); const gauge = document.getElementById('hud-gauge').getBoundingClientRect(); return { top: row.top, bottom: Math.max(row.bottom, gauge.bottom), width: document.documentElement.clientWidth }; })()`
  );
  return { x: 0, y: Math.floor(box.top), width: box.width, height: Math.ceil(box.bottom - box.top) + 2 };
}

// ---- Runs --------------------------------------------------------------------

// Seed 1: the Wisp starts on the right half of the field (x 122), so the
// left side is the safe one to claim first.

/** A fast cut down column 40: the left quarter becomes blue. */
async function firstClaim(page: Page): Promise<Probe> {
  const p = await cutColumn(page, 40, 'Space');
  expect(p.occ > 0 && p.lives === 3, 'first claim', p);
  return p;
}

/** A slow cut up column 128 after the first claim: a red strip on the right. */
async function slowClaim(page: Page): Promise<Probe> {
  const before = await probe(page);
  await walkToX(page, 128);
  const p = await drawUntilClosed(page, 'up', 'Shift');
  expect(p.occ > before.occ && p.lives === 3, 'slow claim', p);
  return p;
}

/** Loses one life to the Igniter: a short stub into the field, then standing still on it. */
async function missToIgniter(page: Page, x: number): Promise<Probe> {
  const before = await probe(page);
  await walkToX(page, x);
  await drawTo(page, before.marker.y === 0 ? 'down' : 'up', before.marker.y === 0 ? 12 : GRID_HEIGHT - 13, 'Space');
  return waitFor(page, (p) => p.lives < before.lives, 20_000, 'the Igniter catches up');
}

/** Ends the run on lives: misses to the Igniter until GAME OVER. */
async function loseAllLives(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const p = await probe(page);
    if (p.status === 'gameover') break;
    await waitOutGrace(page);
    await missToIgniter(page, 70);
  }
  await waitFor(page, (p) => p.status === 'gameover', 5_000, 'GAME OVER');
}

const MODAL_SHOWN = `(() => { const m = document.getElementById('gameover-modal'); return m !== null && getComputedStyle(m).display !== 'none'; })()`;

/** On through the game-ending miss until the GAME OVER modal is up (it asks the board then). */
async function modalShown(page: Page): Promise<void> {
  for (let ms = 0; ms < 5_000; ms += 16) {
    if (await page.evaluate<boolean>(MODAL_SHOWN)) return;
    await page.clock.runFor(16);
  }
  throw new Error('no GAME OVER modal');
}

/** GAME OVER's count-up, highlight and best line all shown. */
async function finishGameOver(page: Page): Promise<void> {
  await modalShown(page);
  await wait(page, 1_500);
  await settle(page, `window.__game__.getGameOverResult().finished`, 'the GAME OVER result');
}

/**
 * Stage 1 cleared by full-height cuts, left to right, away from the Wisp:
 * ends on STAGE CLEAR with its result still counting.
 */
async function clearStage1(page: Page): Promise<Probe> {
  let p = await probe(page);
  for (const x of [40, 70, 95, 115, 135]) {
    if (p.status !== 'playing') break;
    if (p.wisps.every((w) => w.x > x + 6)) {
      p = await cutColumn(page, x, 'Space');
      log('cut', x, JSON.stringify(p));
    }
  }
  expect(p.status === 'stageclear', 'stage 1 clear', p);
  return p;
}

// ---- The table ---------------------------------------------------------------

export const SHOTS: Shot[] = [
  // README
  {
    name: 'readme-title',
    server: 'preview',
    setup: () => base(README, { ranking: SHORT_BOARD, replayPayload: replayPayload() }),
    prepare: (page, opened) => titleDemo(page, opened, 4_000),
  },
  {
    name: 'readme-playing',
    server: 'preview',
    setup: () => base(README),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await slowClaim(page);
      await walkToX(page, 100);
      await waitFor(page, (p) => p.embers.length > 0, 40_000, 'an Ember pair');
      await wait(page, 600);
      await drawTo(page, 'down', 55, 'Space');
      const p = await drawTo(page, 'left', 75, 'Space');
      expect(p.drawing && p.lives === 3 && p.embers.length > 0, 'a line half drawn, an Ember pair out', p);
    },
  },
  {
    name: 'ranking-list',
    server: 'preview',
    setup: () => base(README, { ranking: SHORT_BOARD, replayPayload: replayPayload() }),
    prepare: openRanking,
  },
  {
    name: 'ranking-replay',
    server: 'preview',
    setup: () => base(README, { ranking: SHORT_BOARD, replayPayload: replayPayload() }),
    prepare: async (page, opened) => {
      await openRanking(page, opened);
      const asked = opened.answered.replay;
      await page.locator('#ranking-list-body button').first().click();
      await waitAnswered(page, opened, 'replay', asked + 1);
      await flushTasks(page);
      const steps = await stepTimers(page, `document.getElementById('replay-stage-label') && document.getElementById('replay-stage-label').offsetParent !== null`, 'the replay is built');
      log(`  replay built in ${steps}ms`);
      // Board state from here on: the replay plays on the clock.
      const cleared = `document.getElementById('screen').innerText.includes('CLEAR!')`;
      let reached = false;
      for (let ms = 0; ms < 120_000 && !reached; ms += 16) {
        reached = await page.evaluate<boolean>(cleared);
        if (!reached) await page.clock.runFor(16);
      }
      expect(reached, 'the replay reaches STAGE 1 CLEAR! within 120s');
      await wait(page, 300);
      expect(await page.evaluate<boolean>(cleared), 'STAGE 1 CLEAR! still shown');
    },
  },
  {
    name: 'ranking-submit',
    server: 'preview',
    setup: () => base(README, { ranking: SHORT_BOARD }),
    prepare: async (page, opened) => {
      await waitAnswered(page, opened, 'ranking', 1);
      await startRun(page);
      await firstClaim(page);
      await loseAllLives(page);
      await modalShown(page);
      await waitAnswered(page, opened, 'ranking', 2);
      // The form opens on game time: once the GAME OVER result has shown in
      // full and RANKING_OFFER_DELAY_TICKS more have passed.
      await advanceUntilShown(page, `document.getElementById('ranking-submit-panel') && document.getElementById('ranking-submit-panel').style.display !== 'none'`, 10_000, 'the submission form');
      await wait(page, 1_500);
      expect(await page.evaluate<boolean>(`window.__game__.getRankingOffer().panelShown`), 'the submission form still open');
    },
  },
  {
    name: 'readme-debug',
    server: 'dev',
    setup: () => base(DEBUG, { query: '?debug' }),
    prepare: async (page) => {
      await settle(page, `document.getElementById('debug-panel')`, 'the debug panel');
      await openDebugPanel(page);
      await page.locator('#debug-panel input[type=range]').first().fill('3');
      await page.evaluate(`(document.activeElement && document.activeElement.blur(), true)`);
      await startRun(page);
      await page.getByRole('button', { name: 'TEST CLAIM L' }).click();
      await wait(page, 250);
      await page.getByRole('button', { name: 'TEST CLAIM L' }).click();
      await wait(page, 300);
      await expectState(page, (p) => playingFullLives(p) && p.wisps.length === 3, 'a run with 3 Wisps');
    },
  },
  {
    name: 'readme-debug-sound',
    server: 'dev',
    setup: () => base(DEBUG, { query: '?debug' }),
    prepare: async (page) => {
      await settle(page, `document.getElementById('debug-panel')`, 'the debug panel');
      await openDebugPanel(page);
      await page.evaluate(`(() => { const panel = document.getElementById('debug-panel'); const section = document.getElementById('debug-sound-section'); panel.scrollTop = section.offsetTop - 8; return true; })()`);
      await wait(page, 100);
    },
  },

  // docs/how-to-play.md
  {
    name: 'title',
    server: 'preview',
    setup: () => base(TITLE),
    prepare: async (page) => {
      await wait(page, 1_000);
      await expectState(page, (p) => p.status === 'title', 'the Title screen');
    },
  },
  {
    name: 'how-to-play-panel',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: openHowToPlay,
  },
  {
    name: 'how-to-play-panel-ja',
    server: 'preview',
    setup: () => base(GUIDE, { locale: 'ja-JP' }),
    prepare: openHowToPlay,
  },
  {
    name: 'hud',
    server: 'preview',
    setup: () => base(README),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await wait(page, 1_500);
      await expectState(page, playingFullLives, 'still playing after the first claim');
    },
    clip: hudClip,
  },
  {
    name: 'mobile-playing',
    server: 'preview',
    setup: () => base(PORTRAIT),
    prepare: async (page) => {
      // A key, not a tap: the browser hands a tap's click to the page a
      // little later, on its own time, so the run could start a tick apart.
      await startRun(page);
      await firstClaim(page);
      await wait(page, 1_500);
      await expectState(page, playingFullLives, 'still playing after the first claim');
    },
  },
  {
    name: 'mobile-landscape',
    server: 'preview',
    setup: () => base(LANDSCAPE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await wait(page, 1_500);
      await expectState(page, playingFullLives, 'still playing after the first claim');
    },
  },
  {
    name: 'pause',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await wait(page, 1_000);
      await page.keyboard.press('KeyP');
      await wait(page, 200);
      expect((await probe(page)).paused, 'paused');
    },
  },
  {
    name: 'hint-line',
    server: 'preview',
    setup: () => base(GUIDE, { hintsSeen: [] }),
    prepare: async (page) => {
      await startRun(page);
      await wait(page, 1_000);
      expect((await probe(page)).hint === 'draw', 'the draw hint');
    },
  },
  {
    name: 'hint-line-ja',
    server: 'preview',
    setup: () => base(GUIDE, { hintsSeen: [], locale: 'ja-JP' }),
    prepare: async (page) => {
      await startRun(page);
      await wait(page, 1_000);
      expect((await probe(page)).hint === 'draw', 'the draw hint');
    },
  },
  {
    name: 'border-move',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await walkToX(page, 50);
      await wait(page, 100);
      await expectState(page, (p) => playingFullLives(p) && !p.drawing && p.marker.y === 0, 'the marker on the top edge');
    },
  },
  {
    name: 'line-drawing',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await walkToX(page, 50);
      await drawTo(page, 'down', 45, 'Space');
      const p = await drawTo(page, 'right', 70, 'Space');
      expect(p.drawing && p.lives === 3, 'a line half drawn', p);
    },
  },
  {
    name: 'claim-fast',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await wait(page, 1_500);
      await expectState(page, playingFullLives, 'still playing after the first claim');
    },
  },
  {
    name: 'claim-slow',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await slowClaim(page);
      await wait(page, 1_500);
      await expectState(page, playingFullLives, 'still playing after the slow claim');
    },
  },
  {
    name: 'retract-after',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await walkToX(page, 70);
      await drawTo(page, 'up', 70, 'Space');
      await drawTo(page, 'right', 85, 'Space');
      // Back the way it came: the line is taken in from its end.
      await drawTo(page, 'left', 70, 'Space');
      const p = await drawTo(page, 'down', GRID_HEIGHT - 1, 'Space');
      expect(!p.drawing && p.marker.y === GRID_HEIGHT - 1, 'back on the border', p);
      await wait(page, 300);
    },
  },
  {
    name: 'wisp',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await wait(page, 1_200);
      await expectState(page, (p) => playingFullLives(p) && p.wisps.length === 1, 'the Wisp in play');
    },
    clip: async (page) => clipAround(page, (await probe(page)).wisps[0], 350, 272),
  },
  {
    name: 'ember',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await waitFor(page, (p) => p.embers.length > 0, 40_000, 'an Ember pair');
      await wait(page, 1_500);
      await expectState(page, (p) => playingFullLives(p) && p.embers.length > 0, 'an Ember on the border');
    },
    clip: async (page) => clipAround(page, (await probe(page)).embers[0], 200, 120),
  },
  {
    name: 'ember-blaze',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      // A close-up with no HUD: an Ember pair every 2 seconds, and the first
      // two pairs cleared away, so a pair of Blazes (every spawn cycle from
      // the stage's second on makes Blazes) comes without minutes of play.
      // The overrides are dropped once it is due.
      await walkToX(page, 90);
      await page.evaluate(`window.__game__.session.applyDebugOverrides({ emberSpawnIntervalSec: 2 })`);
      await waitFor(page, (p) => p.embers.length > 0, 40_000, 'the first Ember pair');
      await page.evaluate(`window.__game__.session.applyDebugOverrides({ emberCount: 0 })`);
      await waitFor(page, (p) => p.embers.length > 0, 5_000, 'the second Ember pair');
      await page.evaluate(`(() => { const s = window.__game__.session; s.applyDebugOverrides({ emberCount: 0 }); s.resetDebugOverrides(); return true; })()`);
      // Wait on the border until a Blaze is close, then draw a slow line
      // down: it climbs the line from its root behind the marker.
      await waitFor(page, (p) => p.embers.some((e) => e.blaze && e.y === 0 && Math.abs(e.x - p.marker.x) <= 5), 20_000, 'a Blaze near the marker');
      await page.keyboard.down('Shift');
      await page.keyboard.down('ArrowDown');
      try {
        await waitFor(
          page,
          (p) => p.lives < 3 || p.marker.y >= 100 || p.embers.some((e) => e.blaze && e.x === p.marker.x && e.y >= 10 && p.marker.y - e.y <= 22),
          10_000,
          'the Blaze on the line'
        );
      } finally {
        await page.keyboard.up('ArrowDown');
        await page.keyboard.up('Shift');
      }
      const p = await probe(page);
      log(JSON.stringify(p));
      expect(p.lives === 3 && p.drawing && p.embers.some((e) => e.blaze && e.x === p.marker.x && e.y > 0), 'the Blaze climbing the line', p);
    },
    clip: async (page) => {
      const p = await probe(page);
      const blaze = p.embers.find((e) => e.blaze && e.x === p.marker.x)!;
      return clipAround(page, { x: p.marker.x, y: Math.round((p.marker.y + blaze.y) / 2) }, 240, 210);
    },
  },
  {
    name: 'igniter',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await walkToX(page, 60);
      await drawTo(page, 'down', 26, 'Space');
      await waitFor(page, (p) => p.igniter !== null, 3_000, 'the Igniter');
      await wait(page, 700);
      await expectState(page, (p) => playingFullLives(p) && p.drawing && p.igniter !== null, 'the Igniter on the line');
    },
    clip: async (page) => {
      const p = await probe(page);
      return clipAround(page, { x: p.marker.x, y: Math.round(p.marker.y / 2) }, 140, 200);
    },
  },
  {
    name: 'miss-reason',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await missToIgniter(page, 70);
      await wait(page, 400);
      await expectState(page, (p) => p.status === 'playing' && p.lives === 2, 'just after the miss, 2 lives left');
    },
  },
  {
    name: 'miss-hud',
    server: 'preview',
    setup: () => base(README),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await missToIgniter(page, 70);
      await waitOutGrace(page);
      await wait(page, 500);
      await expectState(page, (p) => p.status === 'playing' && p.lives === 2, 'after the miss, 2 lives left');
    },
    clip: hudClip,
  },
  {
    name: 'stageclear2',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await clearStage1(page);
      await wait(page, 5_000);
      await expectState(page, (p) => p.status === 'stageclear' && p.stage === 1, 'STAGE 1 CLEAR');
    },
  },
  {
    // Stage 3, the first with two Wisps, 1.5 seconds in.
    name: 'two-wisps-field',
    server: 'preview',
    setup: () => base(GUIDE, { seed: SURGE_RUN_SEED }),
    prepare: async (page) => {
      await installSurgeRun(page);
      await startRun(page);
      await playSurgeRunTo(page, (p) => p.status === 'playing' && p.stage === 3 && p.stageTicks >= 90, 'stage 3');
      await expectState(
        page,
        (p) => playingFullLives(p) && p.stage === 3 && p.wisps.length === 2 && p.multiplier === 1 && !p.drawing,
        'stage 3 with 2 Wisps'
      );
    },
  },
  {
    // Stage 3 cleared by a split: the clear screen under SPLIT!.
    name: 'split-clear',
    server: 'preview',
    setup: () => base(GUIDE, { seed: SURGE_RUN_SEED }),
    prepare: async (page) => {
      await installSurgeRun(page);
      await startRun(page);
      await playSurgeRunTo(page, (p) => p.status === 'stageclear' && p.stage === 3, 'stage 3 cleared');
      await wait(page, 400);
      await expectState(page, (p) => p.status === 'stageclear' && p.stage === 3 && p.multiplier === 2 && p.lives === 3, 'stage 3 cleared by a split');
      expect(await page.evaluate<boolean>(`window.__game__.session.getGame().getLastClearWasSplit() && window.__game__.fx.isSplitBannerActive()`), 'SPLIT! shown');
    },
  },
  {
    name: 'gameover',
    server: 'preview',
    setup: () => base(GUIDE),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await loseAllLives(page);
      await finishGameOver(page);
      const result = await gameOverBest(page);
      expect(result.best === 'to-best' && result.highlight !== null, `the highlight and the line to the best: ${JSON.stringify(result)}`);
    },
  },
  {
    name: 'gameover-new-record',
    server: 'preview',
    setup: () => base(GUIDE, { highScore: 1200 }),
    prepare: async (page) => {
      await startRun(page);
      await firstClaim(page);
      await loseAllLives(page);
      await finishGameOver(page);
      const result = await gameOverBest(page);
      expect(result.best === 'new-record', `a new record: ${JSON.stringify(result)}`);
    },
  },
];

async function openDebugPanel(page: Page): Promise<void> {
  const shown = await page.evaluate<boolean>(`getComputedStyle(document.getElementById('debug-panel')).display !== 'none'`);
  if (!shown) await page.locator('#debug-badge').click();
  await wait(page, 100);
}
