// The start cue: as each stage starts, a ring closes in on the marker for the
// stage title's 60 ticks, so the start — at the middle of any of the four
// edges from stage 2 — is seen at a glance. On a faked page clock
// (tests/e2e/support/fakeClock.ts): ticks are counted by wrapping fx.tick(),
// which main.ts calls once per live tick, so nothing waits on the wall clock.
//
// What the renderer drew comes from the renderer itself
// (window.__game__.getStartCue(), logical canvas px) and is mapped onto the
// page through the canvas's own box, then checked against the boxes of the
// HUD, the PAUSE button, the hint line and the touch controls — no pixel
// constant of a font.
import { test, expect, type Page, type Browser } from '@playwright/test';
import { advanceUntil } from './support/fakeClock';
import { markerStartCandidates, type MarkerStartEdge } from '../../src/core/markerStart';
import { mulberry32, deriveStageSeed } from '../../src/core/rng';
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  RENDER_SCALE,
  FX_STAGE_TITLE_TICKS,
  FX_START_CUE_REDUCED_RADIUS_CELLS,
  MARKER_DIAMOND_RADIUS_CELLS,
  FX_START_CUE_MIN_LINE_DISPLAY_PX,
} from '../../src/config';

interface Point {
  x: number;
  y: number;
}
interface Ring {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  lineWidth: number;
}
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Probe {
  ticks: number;
  stageStarts: number[];
}
interface View {
  ticks: number;
  status: string;
  stage: number;
  marker: Point;
  ring: Ring | null;
  cueAge: number | null;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getStage: () => number;
        getStageTicks: () => number;
        getMarkerStart: () => { edge: MarkerStartEdge; point: Point } | null;
        getGame: () => { getMarker: () => { getPosition: () => Point } };
        update: (input: { dx: number; dy: number; drawHeld: boolean; slow?: boolean; confirm: boolean }) => void;
        applyDebugOverrides: (overrides: { requiredOccupancy?: number }) => void;
      };
      fx: {
        tick: () => void;
        getFrame: () => { startCue: { age: number; radiusCells: number; alpha: number } | null };
        onStageStart: (heading: string, title: string) => void;
      };
      getStartCue: () => Ring | null;
      getFxTextBoxes: () => { stageTitle: { x: number; y: number; width: number; height: number } | null };
    };
    __probe__?: Probe;
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const CANVAS_W = GRID_WIDTH * RENDER_SCALE;
const CANVAS_H = GRID_HEIGHT * RENDER_SCALE;
const CANDIDATES = markerStartCandidates(GRID_WIDTH, GRID_HEIGHT);

/** The first seed whose stage 2 starts on `edge` (the candidate its stage-2 rng draws first). */
function seedWithStage2On(edge: MarkerStartEdge): number {
  for (let seed = 1; seed < 10_000; seed++) {
    if (CANDIDATES[Math.floor(mulberry32(deriveStageSeed(seed, 2))() * CANDIDATES.length)].edge === edge) return seed;
  }
  throw new Error(`no seed starts stage 2 on the ${edge} edge`);
}

/** Loads the page on a paused fake clock and counts fx ticks and stage starts. */
async function open(page: Page, query: string): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
  await page.evaluate(() => {
    const g = window.__game__!;
    const probe: Probe = { ticks: 0, stageStarts: [] };
    const tick = g.fx.tick.bind(g.fx);
    g.fx.tick = () => {
      probe.ticks++;
      tick();
    };
    const onStageStart = g.fx.onStageStart.bind(g.fx);
    g.fx.onStageStart = (heading, title) => {
      probe.stageStarts.push(probe.ticks);
      onStageStart(heading, title);
    };
    window.__probe__ = probe;
  });
}

const probe = (page: Page) => page.evaluate(() => window.__probe__!);
const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());

const view = (page: Page): Promise<View> =>
  page.evaluate(() => {
    const g = window.__game__!;
    const cue = g.fx.getFrame().startCue;
    return {
      ticks: window.__probe__!.ticks,
      status: g.session.getStatus(),
      stage: g.session.getStage(),
      marker: g.session.getGame().getMarker().getPosition(),
      ring: g.getStartCue(),
      cueAge: cue ? cue.age : null,
    };
  });

/** Advances the clock a frame at a time until at least one more tick has run. */
async function runOneTick(page: Page): Promise<void> {
  const before = (await probe(page)).ticks;
  await advanceUntil(page, async () => (await probe(page)).ticks > before, 10 * FRAME_MS, FRAME_MS);
}

/** Runs the clock a frame at a time until the stage has started (its first tick drawn). */
async function untilStageStarts(page: Page, count: number): Promise<void> {
  await advanceUntil(page, async () => (await probe(page)).stageStarts.length >= count, 2_000, FRAME_MS);
}

/**
 * From Title, clears stage 1 and starts stage 2. Stage 1's required
 * occupancy is lowered (a debug override) and the session is fed a small box
 * drawn straight down from the top-middle start, along the edge and back up;
 * from stage 2 on the session takes the keys again. The confirm that starts
 * stage 2 is a key press, as in play.
 */
async function playToStage2(page: Page): Promise<void> {
  await page.evaluate(() => {
    const session = window.__game__!.session;
    session.applyDebugOverrides({ requiredOccupancy: 0.00001 });
    const update = session.update.bind(session);
    const box = [
      { dx: 0, dy: 1 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: -1 },
      { dx: 0, dy: -1 },
    ];
    session.update = (input) => {
      if (session.getStage() !== 1 || session.getStatus() !== 'playing') return update(input);
      const step = box[session.getStageTicks()] ?? { dx: 0, dy: 0 };
      return update({ ...step, drawHeld: true, slow: false, confirm: false });
    };
  });
  await page.keyboard.press('Space'); // Title -> stage 1
  await untilStageStarts(page, 1);
  await advanceUntil(page, async () => (await status(page)) === 'stageclear', 5_000, FRAME_MS);
  // A confirm completes the result's count-up (if still counting), the next starts stage 2.
  await page.clock.runFor(1_500);
  for (let i = 0; i < 4 && (await probe(page)).stageStarts.length < 2; i++) {
    await page.keyboard.press('Enter');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length >= 2 || (await status(page)) === 'stageclear', 300, FRAME_MS);
    if ((await probe(page)).stageStarts.length < 2) await page.clock.runFor(200);
  }
  await untilStageStarts(page, 2);
  expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(2);
}

/** The middle of the marker's cell, in logical canvas px. */
const cellMiddle = (p: Point) => ({ x: (p.x + 0.5) * RENDER_SCALE, y: (p.y + 0.5) * RENDER_SCALE });

/** The key that walks the marker along its start edge (the field's inside is only entered while drawing). */
const ALONG_KEY: Record<MarkerStartEdge, string> = { top: 'ArrowLeft', bottom: 'ArrowLeft', left: 'ArrowUp', right: 'ArrowUp' };

/**
 * Watches the cue tick by tick from the stage start until it has gone,
 * holding the key along the edge for ticks 10-29 so the marker moves during
 * it: on every tick up to the 60th from the start the ring is drawn, centred
 * on the marker as it is, then it is not. Returns the frames seen.
 */
async function watchCue(page: Page, edge: MarkerStartEdge): Promise<View[]> {
  const start = (await probe(page)).stageStarts.at(-1)!;
  const seen: View[] = [];
  let held = false;
  for (let guard = 0; guard < 200; guard++) {
    const v = await view(page);
    const since = v.ticks - start;
    seen.push(v);
    expect(v.status).toBe('playing');
    if (since < FX_STAGE_TITLE_TICKS) {
      expect(v.cueAge, `tick ${since}`).toBe(since);
      expect(v.ring, `tick ${since}`).not.toBeNull();
      expect({ x: v.ring!.x, y: v.ring!.y }, `tick ${since}`).toEqual(cellMiddle(v.marker));
    } else {
      expect(v.cueAge, `tick ${since}`).toBeNull();
      expect(v.ring, `tick ${since}`).toBeNull();
      if (since >= FX_STAGE_TITLE_TICKS + 3) break;
    }
    if (since >= 10 && since < 30 && !held) {
      await page.keyboard.down(ALONG_KEY[edge]);
      held = true;
    }
    if (since >= 30 && held) {
      await page.keyboard.up(ALONG_KEY[edge]);
      held = false;
    }
    await runOneTick(page);
  }
  if (held) await page.keyboard.up(ALONG_KEY[edge]);
  // The marker really moved while the cue was up.
  const during = seen.filter((v) => v.ring !== null).map((v) => `${v.marker.x},${v.marker.y}`);
  expect(new Set(during).size).toBeGreaterThan(5);
  return seen;
}

const EDGES: MarkerStartEdge[] = ['top', 'bottom', 'left', 'right'];

/** Opens the page and plays on to the first stage that starts on `edge` (stage 1 for the top, else stage 2). */
async function openAt(page: Page, edge: MarkerStartEdge): Promise<void> {
  if (edge === 'top') {
    await open(page, '?seed=1');
    await page.keyboard.press('Space');
    await untilStageStarts(page, 1);
  } else {
    await open(page, `?seed=${seedWithStage2On(edge)}`);
    await playToStage2(page);
  }
  const start = await page.evaluate(() => window.__game__!.session.getMarkerStart());
  expect(start?.edge).toBe(edge);
  expect(await page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition())).toEqual(start!.point);
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test.describe(`the start cue (${reducedMotion === 'reduce' ? 'reduced motion' : 'motion'})`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, reducedMotion });

    for (const edge of EDGES) {
      test(`on a ${edge} start (stage ${edge === 'top' ? 1 : 2}): a ring on the marker for 60 ticks, following it, then gone`, async ({ page }) => {
        await openAt(page, edge);
        const seen = await watchCue(page, edge);
        const radii = seen.filter((v) => v.ring !== null).map((v) => v.ring!.radius);
        if (reducedMotion === 'reduce') {
          // One size throughout, fading out.
          for (const r of radii) expect(r).toBe(FX_START_CUE_REDUCED_RADIUS_CELLS * RENDER_SCALE);
          const alphas = seen.filter((v) => v.ring !== null).map((v) => v.ring!.alpha);
          for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThan(alphas[i - 1]);
        } else {
          // Closing in: it shrinks, and starts over once (two rings).
          let restarts = 0;
          for (let i = 1; i < radii.length; i++) {
            if (radii[i] > radii[i - 1]) restarts++;
            else expect(radii[i]).toBeLessThan(radii[i - 1]);
          }
          expect(restarts).toBe(1);
        }
      });
    }
  });
}

test.describe('the start cue is not shown', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('on the Title screen before a run', async ({ page }) => {
    await open(page, '?seed=1');
    for (let i = 0; i < 10; i++) {
      await page.clock.runFor(100);
      expect((await view(page)).ring).toBeNull();
    }
  });
});

/** Every box over the page the marker and the ring must stay clear of, and the canvas. */
async function obstacles(page: Page): Promise<{ canvas: Rect; others: Array<{ name: string; rect: Rect }> }> {
  return page.evaluate(() => {
    const toRect = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const canvas = document.getElementById('game-canvas')!.getBoundingClientRect();
    const others: Array<{ name: string; rect: { left: number; top: number; right: number; bottom: number } }> = [];
    const selectors = ['#hud-row', '#pause-button', '#hint-bar', '#touch-dpad button', '#touch-actions button', '#mute-button', '#credit-link'];
    for (const selector of selectors) {
      document.querySelectorAll<HTMLElement>(selector).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) return;
        others.push({ name: `${selector}[${i}]`, rect: toRect(r) });
      });
    }
    return { canvas: toRect(canvas), others };
  });
}

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** A logical-canvas box (clipped to the field) as a page rect. */
function toPage(canvas: Rect, box: { left: number; top: number; right: number; bottom: number }): Rect {
  const sx = (canvas.right - canvas.left) / CANVAS_W;
  const sy = (canvas.bottom - canvas.top) / CANVAS_H;
  const clip = {
    left: Math.max(0, box.left),
    top: Math.max(0, box.top),
    right: Math.min(CANVAS_W, box.right),
    bottom: Math.min(CANVAS_H, box.bottom),
  };
  return {
    left: canvas.left + clip.left * sx,
    top: canvas.top + clip.top * sy,
    right: canvas.left + clip.right * sx,
    bottom: canvas.top + clip.bottom * sy,
  };
}

/** The marker and the ring's part inside the field are on the field, with room, and under nothing. */
async function expectCueInView(page: Page, label: string): Promise<void> {
  const v = await view(page);
  expect(v.ring, label).not.toBeNull();
  const { canvas, others } = await obstacles(page);
  const m = cellMiddle(v.marker);
  const markerR = MARKER_DIAMOND_RADIUS_CELLS * RENDER_SCALE;
  const marker = toPage(canvas, { left: m.x - markerR, top: m.y - markerR, right: m.x + markerR, bottom: m.y + markerR });
  const r = v.ring!;
  const ring = toPage(canvas, { left: r.x - r.radius, top: r.y - r.radius, right: r.x + r.radius, bottom: r.y + r.radius });
  const sx = (canvas.right - canvas.left) / CANVAS_W;
  // Its line is never thinner than FX_START_CUE_MIN_LINE_DISPLAY_PX on screen.
  expect(r.lineWidth * sx, `${label} line width`).toBeGreaterThanOrEqual(FX_START_CUE_MIN_LINE_DISPLAY_PX - 0.01);
  // A start on an edge shows the half of the ring inside the field.
  expect(Math.min(ring.right - ring.left, ring.bottom - ring.top), `${label} ring shown`).toBeGreaterThanOrEqual(r.radius * sx - 0.5);
  for (const [name, box] of [
    ['marker', marker],
    ['ring', ring],
  ] as const) {
    expect(box.left, `${label} ${name} left`).toBeGreaterThanOrEqual(canvas.left - 0.5);
    expect(box.right, `${label} ${name} right`).toBeLessThanOrEqual(canvas.right + 0.5);
    expect(box.top, `${label} ${name} top`).toBeGreaterThanOrEqual(canvas.top - 0.5);
    expect(box.bottom, `${label} ${name} bottom`).toBeLessThanOrEqual(canvas.bottom + 0.5);
    for (const other of others) expect(overlaps(box, other.rect), `${label} ${name} under ${other.name}`).toBe(false);
  }
}

const VIEWPORTS = [
  { name: 'desktop 1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: 'phone 390x844', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: 'phone landscape 844x390', viewport: { width: 844, height: 390 }, hasTouch: true },
  { name: 'phone landscape 667x375', viewport: { width: 667, height: 375 }, hasTouch: true },
];

async function newPage(browser: Browser, vp: (typeof VIEWPORTS)[number]) {
  const context = await browser.newContext({ viewport: vp.viewport, hasTouch: vp.hasTouch });
  return { context, page: await context.newPage() };
}

for (const vp of VIEWPORTS) {
  test.describe(`the start cue on a ${vp.name}`, () => {
    for (const edge of ['bottom', 'left', 'right'] as const) {
      test(`on a ${edge} start: the marker and the ring are on the field, clear of the HUD and the controls`, async ({ browser }) => {
        const { context, page } = await newPage(browser, vp);
        await openAt(page, edge);
        // The largest ring (the stage's first tick) and one well into each pulse.
        const start = (await probe(page)).stageStarts.at(-1)!;
        for (const at of [0, 20, 30, 50]) {
          await advanceUntil(page, async () => (await probe(page)).ticks - start >= at, 2_000, FRAME_MS);
          await expectCueInView(page, `${vp.name} ${edge} tick ${at}`);
        }
        await context.close();
      });
    }
  });
}
