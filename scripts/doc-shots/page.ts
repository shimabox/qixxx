// One page of the game, set up so the same steps always draw the same
// picture: a faked clock paused before the page loads (no frame is drawn
// on real time), the live run's seed and the saved settings fixed before any
// script runs, the ranking API answered with made-up data, and every
// request off this machine stopped and counted.
//
// The code run inside the page is passed as strings: this project's script
// type check has no DOM types, and the strings keep it that way.
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';

export const CLOCK_START = new Date('2026-11-01T03:00:00Z');
export const TIMEZONE = 'Asia/Tokyo';
/** One rendered frame on the faked clock. */
export const FRAME_MS = 16;
const RANKING_API = /\/api\/ranking$/;
const REPLAY_API = /\/api\/ranking\/[^/]+\/replay$/;

export interface Viewport {
  width: number;
  height: number;
  /** A touch device (the on-screen buttons). */
  touch: boolean;
}

export interface RankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

export interface PageSetup {
  viewport: Viewport;
  locale: 'en-US' | 'ja-JP';
  /** The live run's seed (main.ts draws it from crypto.getRandomValues()). */
  seed: number;
  /** The saved high score, or null for none. */
  highScore: number | null;
  /** The in-play hints already seen on this device. */
  hintsSeen: readonly string[];
  /** SOUND: ON saved. */
  soundOn: boolean;
  /** GET /api/ranking: the board's entries, or 'fail' for an error answer. */
  ranking: RankingEntry[] | 'fail';
  /** GET /api/ranking/{id}/replay's body, if any is asked for. */
  replayPayload?: string;
  rulesetVersion: number;
  /** The page's address under the server, e.g. '?debug'. */
  query?: string;
}

export interface OpenPage {
  context: BrowserContext;
  page: Page;
  /** Requests to anywhere but this machine (stopped). */
  offsite: string[];
  /** How many GET /api/ranking and replay answers have been sent to the page. */
  answered: { ranking: number; replay: number };
}

export const ALL_HINTS = ['draw', 'claimSide', 'slow', 'split', 'ember', 'blaze', 'igniter'] as const;

function initScript(setup: PageSetup): string {
  const storage: Record<string, string> = {};
  if (setup.highScore !== null) storage['qixxx.highScore'] = String(setup.highScore);
  if (setup.hintsSeen.length > 0) storage['qixxx.hintsSeen'] = JSON.stringify(setup.hintsSeen);
  storage['qixxx.muted'] = setup.soundOn ? 'false' : 'true';
  return `(() => {
    const seed = ${setup.seed};
    const real = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (array) => {
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = seed;
        return array;
      }
      return real(array);
    };
    try {
      localStorage.clear();
      const values = ${JSON.stringify(storage)};
      for (const key of Object.keys(values)) localStorage.setItem(key, values[key]);
    } catch (error) {
      // No storage on this page (about:blank).
    }
  })();`;
}

function isLocal(url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * The faked performance.now() the first frame is drawn at. The game loop
 * takes its start time when the page's script loads, and that reading
 * carries the few ms of real time the load took, a different number each
 * run. Jumping well past it (more than MAX_FRAME_DELTA, 0.25s) makes the
 * first frame's step the capped 0.25s whatever the load took, and puts every
 * later frame on the same 16ms boundaries, so the ticks fall on the same
 * frames every run.
 */
const FIRST_FRAME_AT = 1_000;

/** Before any frame: jumps the stopped clock to FIRST_FRAME_AT, firing what is due once (the first frame). */
async function alignFirstFrame(page: Page): Promise<void> {
  const before = await page.evaluate<number>('performance.now()');
  if (!(before >= 0 && before < FIRST_FRAME_AT - 300)) {
    throw new Error(`the page loaded at performance.now() = ${before}, too late to line its first frame up at ${FIRST_FRAME_AT}`);
  }
  await page.clock.fastForward(FIRST_FRAME_AT - before);
  const after = await page.evaluate<number>('performance.now()');
  if (after !== FIRST_FRAME_AT) {
    throw new Error(`the first frame's clock is at performance.now() = ${after}, not ${FIRST_FRAME_AT} (it was ${before})`);
  }
  if (process.argv.includes('--log')) console.log(`  loaded at performance.now() = ${before}`);
}

/** A new context and page on `base`, the clock paused before the page loads and the first frames drawn. */
export async function openPage(browser: Browser, base: string, setup: PageSetup): Promise<OpenPage> {
  const context = await browser.newContext({
    locale: setup.locale,
    timezoneId: TIMEZONE,
    viewport: { width: setup.viewport.width, height: setup.viewport.height },
    deviceScaleFactor: 2,
    hasTouch: setup.viewport.touch,
    isMobile: false,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const offsite: string[] = [];
  const answered = { ranking: 0, replay: 0 };
  await page.route('**/*', async (route: Route) => {
    const url = route.request().url();
    if (!isLocal(url)) {
      offsite.push(url);
      return route.abort();
    }
    if (REPLAY_API.test(new URL(url).pathname)) {
      if (setup.replayPayload === undefined) await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
      else await route.fulfill({ status: 200, contentType: 'application/json', body: setup.replayPayload });
      answered.replay++;
      return;
    }
    if (RANKING_API.test(new URL(url).pathname)) {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
      if (setup.ranking === 'fail') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
      } else {
        const displayEntries = setup.ranking.map((entry) => ({ ...entry, status: 'verified' }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ seasonId: 1, rulesetVersion: setup.rulesetVersion, entries: setup.ranking, displayEntries }),
        });
      }
      answered.ranking++;
      return;
    }
    return route.continue();
  });
  await page.addInitScript({ content: initScript(setup) });
  await page.clock.install({ time: CLOCK_START });
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.goto(base + (setup.query ?? ''));
  // The effects' face (src/render/fxFonts.ts) before anything is drawn with it.
  await page.evaluate(`Promise.all([document.fonts.load('900 16px "Orbitron"'), document.fonts.load('700 16px "Orbitron"')]).then(() => document.fonts.ready).then(() => true)`);
  await alignFirstFrame(page);
  await page.clock.runFor(100);
  return { context, page, offsite, answered };
}

export interface Point {
  x: number;
  y: number;
}

/** What a step reads from the game (window.__game__, the E2E hook). */
export interface Probe {
  status: string;
  score: number;
  stage: number;
  lives: number;
  occ: number;
  required: number;
  multiplier: number;
  marker: Point;
  drawing: boolean;
  grace: number;
  wisps: Point[];
  embers: Array<Point & { blaze: boolean }>;
  igniter: Point | null;
  hint: string | null;
  paused: boolean;
  demoState: string;
  demoShown: boolean;
  demoTicks: number | null;
  ticks: number;
  remaining: number;
}

const PROBE = `(() => {
  const g = window.__game__;
  const s = g.session;
  const game = s.getGame();
  const m = game.getMarker();
  const p = m.getPosition();
  const demo = g.getTitleDemo();
  const hint = g.getHint();
  const igniter = game.getIgniterPosition();
  return {
    status: s.getStatus(),
    score: s.getScore(),
    stage: s.getStage(),
    lives: s.getLives(),
    occ: game.getOccupancy(),
    required: game.getRequiredOccupancy(),
    multiplier: s.getMultiplier(),
    marker: { x: p.x, y: p.y },
    drawing: m.isDrawing(),
    grace: game.getGraceTicks(),
    wisps: game.getWisps().map((w) => { const q = w.getPosition(); return { x: q.x, y: q.y }; }),
    embers: game.getEmbers().map((e) => { const q = e.getPosition(); return { x: q.x, y: q.y, blaze: e.isBlaze() }; }),
    igniter: igniter ? { x: igniter.x, y: igniter.y } : null,
    hint: hint ? hint.id : null,
    paused: g.isPaused(),
    demoState: demo.state,
    demoShown: demo.shown,
    demoTicks: demo.ticks,
    ticks: s.getTotalTicks(),
    remaining: s.getRemainingTicks(),
  };
})()`;

export function probe(page: Page): Promise<Probe> {
  return page.evaluate<Probe>(PROBE);
}

/**
 * Advances the faked clock one frame at a time until `predicate` holds on
 * the game's state. Only for the board's own state, never for a network
 * answer (when an answer lands is not tied to the faked clock).
 */
export async function advanceUntil(page: Page, predicate: (p: Probe) => boolean, maxMs: number, what: string): Promise<Probe> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += FRAME_MS) {
    const state = await probe(page);
    if (predicate(state)) return state;
    await page.clock.runFor(FRAME_MS);
  }
  throw new Error(`${what}: not reached within ${maxMs}ms of game time`);
}
