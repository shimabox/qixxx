// The Wisp surge (src/core/wispSurge.ts): on NORMAL, a claim that brings a
// stage's occupancy near its goal speeds every Wisp up, turns their heads the
// level's color, spreads a ring from every head for a moment and plays the
// surge sound; on EASY nothing changes. On a faked, paused page clock
// (tests/e2e/support/fakeClock.ts), so every wait is game time.
//
// The run is a `?seed=` one (the cue does not depend on it). Stage 1's
// inputs are fed to the session: after the stage title has gone, a small box
// straight down from the top-middle start, along the edge and back up; then
// the goal is lowered to four times that box's occupancy (a debug override —
// short of half of it, so still level 0); then a second box sharing the
// first one's side brings occupancy to three times the first: past half of
// the goal and within 0.10 of it, so that claim raises the level to 2.
//
// Where the ring was drawn comes from the renderer itself
// (window.__game__.getWispSurgeDraw(), logical canvas px) and is mapped onto
// the page through the canvas's own box, then checked against the boxes of
// the HUD, the PAUSE button, the hint line and the touch controls, and the
// stage title and claim tags drawn on the field — no pixel constant of a
// font. That the ring and the heads are really drawn in the level color is
// read from the canvas's own pixels (colorDistances()).
//
// A second script, one fast line from the top-middle start to the bottom
// edge, raises the level on the run's first claim, which also shows the
// claimed-side hint with its ring around the same Wisp: the two rings' radii
// and line widths, as drawn, never meet, with full and with reduced motion.
// The hint line shows with them and may lie over a part of the ring: it
// stays whole and on top, and most of the ring stays in sight around it.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil } from './support/fakeClock';
import { installFakeAudio } from './support/fakeAudio';
import { GRID_WIDTH, GRID_HEIGHT, RENDER_SCALE, WISP_SURGE_CUE_TICKS, FX_STAGE_TITLE_TICKS } from '../../src/config';
import { HINT_RING_OUTLINE_WIDTH_PX } from '../../src/render/hintLayer';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Ring {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: string;
  lineWidth: number;
}
interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Probe {
  /** fx ticks (one per live tick) since the page's hooks were installed. */
  ticks: number;
  /** The fx tick of every surge cue started, and its level. */
  cues: Array<{ tick: number; level: number }>;
}
interface View {
  status: string;
  stage: number;
  stageTicks: number;
  occupancy: number;
  required: number;
  level: number;
  speeds: number[];
  panelSpeed: number;
  rings: Ring[];
  headColors: string[];
  heads: Array<{ x: number; y: number }>;
  sounds: string[];
}

declare global {
  interface Window {
    __surgeProbe__?: Probe;
  }
}

type Hook = {
  session: {
    getStatus: () => string;
    getStage: () => number;
    getStageTicks: () => number;
    getEffectiveDebugParams: () => { wispSpeedMultiplier: number };
    applyDebugOverrides: (o: { requiredOccupancy?: number }) => void;
    update: (input: { dx: number; dy: number; drawHeld: boolean; slow?: boolean; confirm: boolean }) => void;
    getGame: () => {
      getOccupancy: () => number;
      getRequiredOccupancy: () => number;
      getWispSurgeLevel: () => number;
      getWisps: () => Array<{ getSpeedMultiplier: () => number; getPosition: () => { x: number; y: number } }>;
    };
  };
  fx: { tick: () => void; onWispSurge: (notice: { level: number }) => void };
  getWispSurgeDraw: () => { rings: Ring[]; headColors: string[] };
  getFxTextBoxes: () => { stageTitle: TextBox | null; claimTags: TextBox[] };
  getSfxLog: () => string[];
};

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const CANVAS_W = GRID_WIDTH * RENDER_SCALE;
const CANVAS_H = GRID_HEIGHT * RENDER_SCALE;
// The boxes start once the stage title has gone, so the ring never meets it.
const FIRST_BOX_AT = FX_STAGE_TITLE_TICKS + 10;
const GOAL_AT = FIRST_BOX_AT + 8;
const SECOND_BOX_AT = FIRST_BOX_AT + 10;
const SURGE_CLAIM_STAGE_TICK = SECOND_BOX_AT + 6;

const hook = (): Hook => (window as unknown as { __game__: Hook }).__game__;

/**
 * Loads the page on a paused fake clock, counts fx ticks and surge cues, and
 * feeds stage 1's script to the session: the two boxes, or (`line`) one fast
 * line straight down from the top-middle start to the bottom edge, whose
 * claim takes past half of the goal at once.
 */
async function open(page: Page, options: { easy?: boolean; line?: boolean } = {}): Promise<void> {
  await installFakeAudio(page);
  await page.addInitScript((easy: boolean) => {
    localStorage.setItem('qixxx.muted', 'false');
    if (easy) localStorage.setItem('qixxx.difficulty', 'easy');
  }, options.easy ?? false);
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}?seed=5`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
  await page.evaluate(
    ({ firstBoxAt, goalAt, secondBoxAt, line }) => {
      const g = (window as unknown as { __game__: Hook }).__game__;
      const probe: Probe = { ticks: 0, cues: [] };
      window.__surgeProbe__ = probe;
      const tick = g.fx.tick.bind(g.fx);
      g.fx.tick = () => {
        probe.ticks++;
        tick();
      };
      const onWispSurge = g.fx.onWispSurge.bind(g.fx);
      g.fx.onWispSurge = (notice) => {
        probe.cues.push({ tick: probe.ticks, level: notice.level });
        onWispSurge(notice);
      };
      const box = [
        { dx: 0, dy: 1 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: 0 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: -1 },
        { dx: 0, dy: -1 },
      ];
      const session = g.session;
      const update = session.update.bind(session);
      session.update = (input) => {
        if (session.getStage() !== 1 || session.getStatus() !== 'playing') return update(input);
        const t = session.getStageTicks();
        if (line) {
          const down = t >= firstBoxAt && session.getGame().getOccupancy() === 0;
          return update({ dx: 0, dy: down ? 1 : 0, drawHeld: down, slow: false, confirm: false });
        }
        if (t === goalAt) session.applyDebugOverrides({ requiredOccupancy: session.getGame().getOccupancy() * 4 });
        const step = box[t - firstBoxAt] ?? box[t - secondBoxAt] ?? { dx: 0, dy: 0 };
        return update({ ...step, drawHeld: true, slow: false, confirm: false });
      };
    },
    { firstBoxAt: FIRST_BOX_AT, goalAt: GOAL_AT, secondBoxAt: SECOND_BOX_AT, line: options.line ?? false }
  );
}

const view = (page: Page): Promise<View> =>
  page.evaluate(() => {
    const g = (window as unknown as { __game__: Hook }).__game__;
    const game = g.session.getGame();
    const draw = g.getWispSurgeDraw();
    return {
      status: g.session.getStatus(),
      stage: g.session.getStage(),
      stageTicks: g.session.getStageTicks(),
      occupancy: game.getOccupancy(),
      required: game.getRequiredOccupancy(),
      level: game.getWispSurgeLevel(),
      speeds: game.getWisps().map((w) => w.getSpeedMultiplier()),
      panelSpeed: g.session.getEffectiveDebugParams().wispSpeedMultiplier,
      rings: draw.rings,
      headColors: draw.headColors,
      heads: game.getWisps().map((w) => w.getPosition()),
      sounds: g.getSfxLog().filter((name) => name.startsWith('wisp-surge')),
    };
  });

const probe = (page: Page) => page.evaluate(() => window.__surgeProbe__!);

/** Starts the run with a key press and plays on until the stage's tick `stageTick` has run, then lets a frame draw it. */
async function playTo(page: Page, stageTick: number): Promise<void> {
  await page.keyboard.press('Space');
  await advanceUntil(page, async () => (await view(page)).status === 'playing', 2_000, FRAME_MS);
  await advanceUntil(page, async () => (await view(page)).stageTicks >= stageTick, 10_000, FRAME_MS);
  await page.clock.runFor(FRAME_MS * 2);
}

/** Every box over the page the ring must stay clear of, and the canvas. */
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

/** A logical-canvas box, clipped to the field, as a page rect. */
function toPage(canvas: Rect, box: Rect): Rect {
  const sx = (canvas.right - canvas.left) / CANVAS_W;
  const sy = (canvas.bottom - canvas.top) / CANVAS_H;
  return {
    left: canvas.left + Math.max(0, box.left) * sx,
    top: canvas.top + Math.max(0, box.top) * sy,
    right: canvas.left + Math.min(CANVAS_W, box.right) * sx,
    bottom: canvas.top + Math.min(CANVAS_H, box.bottom) * sy,
  };
}

const ringBox = (r: Ring): Rect => ({ left: r.x - r.radius, top: r.y - r.radius, right: r.x + r.radius, bottom: r.y + r.radius });
const textBox = (b: TextBox): Rect => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height });

interface Point {
  x: number;
  y: number;
}

/** `count` points evenly spaced around a circle (logical canvas px), in order of angle. */
function circlePoints(center: Point, radius: number, count: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) };
  });
}

const onField = (p: Point) => p.x >= 0 && p.x < CANVAS_W && p.y >= 0 && p.y < CANVAS_H;

/** A logical-canvas point, as a page point through the canvas's own box. */
const pointToPage = (canvas: Rect, p: Point): Point => ({
  x: canvas.left + (p.x / CANVAS_W) * (canvas.right - canvas.left),
  y: canvas.top + (p.y / CANVAS_H) * (canvas.bottom - canvas.top),
});

const inside = (p: Point, r: Rect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/**
 * The canvas's own pixels: for each logical point, the RGB distance from
 * `color` of the closest pixel within `reach` logical px of it (device px
 * through the canvas's backing-store scale). The reach takes in the line's
 * antialiasing and the board's shake on a claim (FX_SHAKE_SMALL, 2 px).
 */
const colorDistances = (page: Page, points: Point[], color: string, reach: number): Promise<number[]> =>
  page.evaluate(
    ({ points, color, reach, canvasW }) => {
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const scale = canvas.width / canvasW;
      const want = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      const r = Math.max(1, Math.round(reach * scale));
      return points.map((p) => {
        const data = ctx.getImageData(Math.round(p.x * scale) - r, Math.round(p.y * scale) - r, r * 2 + 1, r * 2 + 1).data;
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < data.length; i += 4) best = Math.min(best, Math.hypot(data[i] - want[0], data[i + 1] - want[1], data[i + 2] - want[2]));
        return best;
      });
    },
    { points, color, reach, canvasW: CANVAS_W }
  );

// A pixel is "in" a color within this RGB distance. Pixels are only read on
// frames where the ring is drawn at alpha >= RING_PIXEL_MIN_ALPHA, and the
// head's core is opaque: over the darkest board (COLOR_BACKGROUND) a ring at
// alpha 0.8 lands about 53 from its color. Every other color drawn on this
// board lies well past 70 from the level 2 color the run reaches: the Wisp
// trail at x1.3 (~150), the claimed fast blue (~230), the line yellow (~165),
// the marker white (~230), the background (~270) and COLOR_WISP_HEAD (~150).
const COLOR_NEAR = 70;
const RING_PIXEL_MIN_ALPHA = 0.8;
const RING_SAMPLES = 48;
const HEAD_REACH = 1.5;
const RING_REACH = 2.5;

// Of the ring's points on the field, the share in the level color: every one
// of them on all four screens, measured (the farthest 38 from the color), so
// half leaves room for a popup or the marker drawn over a part of it. Where
// the ring is not drawn, none of them (the nearest 134 from it), so a tenth
// leaves room for the head's own glow or trail crossing the circle.
const RING_PIXEL_MIN_SHARE = 0.5;
const NO_RING_PIXEL_MAX_SHARE = 0.1;
// Of the points evenly spread around a ring, the share on the field and
// under none of the page's boxes (the hint line, the HUD, PAUSE, the touch
// controls): measured 0.77 at the least, at 667x375 where the ring passes
// under the hint line, and 0.94 or more on the other screens (a part off the
// field's edge). Half leaves room for the line wrapping to one more row, and
// still fails a ring the line or the HUD covers for the most part.
const RING_SHOWN_MIN_SHARE = 0.5;

/** The share of `points` whose pixels are within COLOR_NEAR of `color`. */
async function shareInColor(page: Page, points: Point[], color: string, reach: number): Promise<number> {
  expect(points.length).toBeGreaterThan(0);
  const distances = await colorDistances(page, points, color, reach);
  return distances.filter((d) => d <= COLOR_NEAR).length / distances.length;
}

/** Whether the pixel at each Wisp head's center (logical px) is in `color`. */
async function headsInColor(page: Page, heads: Point[], color: string): Promise<boolean[]> {
  const centers = heads.map((h) => ({ x: (h.x + 0.5) * RENDER_SCALE, y: (h.y + 0.5) * RENDER_SCALE }));
  return (await colorDistances(page, centers, color, HEAD_REACH)).map((d) => d <= COLOR_NEAR);
}

test.describe('the Wisp surge on NORMAL', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the claim that crosses raises the level: every Wisp x1.3, the heads and a ring in the level color, the surge sound once; the panel keeps x1', async ({ page }) => {
    await open(page);
    await playTo(page, SECOND_BOX_AT);
    const before = await view(page);
    expect(before.stage).toBe(1);
    expect(before.level).toBe(0);
    expect(before.occupancy).toBeGreaterThan(0);
    expect(before.required).toBeCloseTo(before.occupancy * 4, 12);
    expect(before.speeds).toEqual([1]);
    expect(before.headColors).toEqual(['#b967ff']);
    expect(await headsInColor(page, before.heads, '#b967ff')).toEqual([true]);
    expect(before.rings).toEqual([]);
    expect(before.sounds).toEqual([]);
    expect((await probe(page)).cues).toEqual([]);

    await advanceUntil(page, async () => (await view(page)).stageTicks >= SURGE_CLAIM_STAGE_TICK, 2_000, FRAME_MS);
    await page.clock.runFor(FRAME_MS * 2);
    const after = await view(page);
    expect(after.status).toBe('playing');
    expect(after.occupancy).toBeCloseTo(before.occupancy * 3, 12);
    expect(after.level).toBe(2);
    expect(after.speeds).toEqual([1.3]);
    expect(after.panelSpeed).toBe(1);
    expect(after.headColors).toEqual(['#ff3d81']);
    expect(after.rings).toHaveLength(1);
    expect(after.rings[0].color).toBe('#ff3d81');
    // As drawn on the canvas: the head and the ring's line in the level color.
    expect(await headsInColor(page, after.heads, '#ff3d81')).toEqual([true]);
    expect(after.rings[0].alpha).toBeGreaterThanOrEqual(RING_PIXEL_MIN_ALPHA);
    const ringPoints = circlePoints(after.rings[0], after.rings[0].radius, RING_SAMPLES).filter(onField);
    expect(await shareInColor(page, ringPoints, '#ff3d81', RING_REACH)).toBeGreaterThanOrEqual(RING_PIXEL_MIN_SHARE);
    expect(after.sounds).toEqual(['wisp-surge-2']);
    const cues = (await probe(page)).cues;
    expect(cues.map((c) => c.level)).toEqual([2]);

    // The ring is gone WISP_SURGE_CUE_TICKS after it started, and nothing more plays.
    await advanceUntil(page, async () => (await probe(page)).ticks >= cues[0].tick + WISP_SURGE_CUE_TICKS + 2, 2_000, FRAME_MS);
    await page.clock.runFor(FRAME_MS * 2);
    const later = await view(page);
    expect(later.status).toBe('playing');
    expect(later.rings).toEqual([]);
    expect(later.headColors).toEqual(['#ff3d81']);
    expect(await headsInColor(page, later.heads, '#ff3d81')).toEqual([true]);
    // Around the head, where the ring was, no line in the level color now.
    const center = { x: (later.heads[0].x + 0.5) * RENDER_SCALE, y: (later.heads[0].y + 0.5) * RENDER_SCALE };
    const noRing = circlePoints(center, after.rings[0].radius, RING_SAMPLES).filter(onField);
    expect(await shareInColor(page, noRing, '#ff3d81', RING_REACH)).toBeLessThanOrEqual(NO_RING_PIXEL_MAX_SHARE);
    expect(later.sounds).toEqual(['wisp-surge-2']);
    expect((await probe(page)).cues).toHaveLength(1);
  });
});

test.describe('the Wisp surge on EASY', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the same claims change no Wisp speed, color, ring or sound', async ({ page }) => {
    await open(page, { easy: true });
    await expect(page.locator('#difficulty-button')).toContainText('EASY');
    await playTo(page, SURGE_CLAIM_STAGE_TICK + 10);
    const v = await view(page);
    expect(v.status).toBe('playing');
    expect(v.occupancy).toBeGreaterThan(0);
    expect(v.occupancy).toBeGreaterThan(v.required / 2);
    expect(v.level).toBe(0);
    expect(v.speeds).toEqual([0.7]);
    expect(v.headColors).toEqual(['#b967ff']);
    expect(v.rings).toEqual([]);
    expect(v.sounds).toEqual([]);
    expect((await probe(page)).cues).toEqual([]);
  });
});

const VIEWPORTS = [
  { width: 1280, height: 800, touch: false },
  { width: 390, height: 844, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 667, height: 375, touch: true },
];

for (const vp of VIEWPORTS) {
  test.describe(`the surge ring at ${vp.width}x${vp.height}${vp.touch ? ' (touch)' : ''}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });

    test('is drawn on the field, clear of the HUD, PAUSE, the hint line, the touch controls and the field texts, for as long as it shows', async ({ page }) => {
      await open(page);
      await playTo(page, SURGE_CLAIM_STAGE_TICK);
      const cues = (await probe(page)).cues;
      expect(cues.map((c) => c.level)).toEqual([2]);
      let framesWithRing = 0;
      let framesWithRingPixels = 0;
      let ringRadius = 0;
      for (let guard = 0; guard < 200; guard++) {
        const v = await view(page);
        if ((await probe(page)).ticks >= cues[0].tick + WISP_SURGE_CUE_TICKS) break;
        expect(v.status).toBe('playing');
        expect(v.rings).toHaveLength(1);
        // On the Wisp's head as it is now (the frame drawn shows the last tick played).
        expect({ x: v.rings[0].x, y: v.rings[0].y }).toEqual({ x: (v.heads[0].x + 0.5) * RENDER_SCALE, y: (v.heads[0].y + 0.5) * RENDER_SCALE });
        // As drawn on the canvas: the head in the level color, and the ring's
        // line in it too while it is still strong.
        expect(await headsInColor(page, v.heads, '#ff3d81'), `head pixel at frame ${framesWithRing}`).toEqual([true]);
        if (v.rings[0].alpha >= RING_PIXEL_MIN_ALPHA) {
          const points = circlePoints(v.rings[0], v.rings[0].radius, RING_SAMPLES).filter(onField);
          expect(await shareInColor(page, points, '#ff3d81', RING_REACH), `ring pixels at frame ${framesWithRing}`).toBeGreaterThanOrEqual(RING_PIXEL_MIN_SHARE);
          framesWithRingPixels++;
          ringRadius = v.rings[0].radius;
        }
        framesWithRing++;
        const { canvas, others } = await obstacles(page);
        const ring = toPage(canvas, ringBox(v.rings[0]));
        // Clipped to the field, a part of it is always inside it.
        expect(ring.right).toBeGreaterThan(ring.left);
        expect(ring.bottom).toBeGreaterThan(ring.top);
        for (const { name, rect } of others) expect(overlaps(ring, rect), `${name} at frame ${framesWithRing}`).toBe(false);
        const texts = await page.evaluate(() => (window as unknown as { __game__: Hook }).__game__.getFxTextBoxes());
        for (const b of [texts.stageTitle, ...texts.claimTags].filter((b): b is TextBox => b !== null)) {
          expect(overlaps(ringBox(v.rings[0]), textBox(b)), `field text at frame ${framesWithRing}`).toBe(false);
        }
        await page.clock.runFor(FRAME_MS * 3);
      }
      expect(framesWithRing).toBeGreaterThan(3);
      expect(framesWithRingPixels).toBeGreaterThan(0);
      // The first frame without the ring: the head keeps the level color, and
      // around it no line in that color.
      await page.clock.runFor(FRAME_MS * 2);
      const gone = await view(page);
      expect(gone.status).toBe('playing');
      expect(gone.rings).toEqual([]);
      expect(await headsInColor(page, gone.heads, '#ff3d81')).toEqual([true]);
      const center = { x: (gone.heads[0].x + 0.5) * RENDER_SCALE, y: (gone.heads[0].y + 0.5) * RENDER_SCALE };
      const points = circlePoints(center, ringRadius, RING_SAMPLES).filter(onField);
      expect(await shareInColor(page, points, '#ff3d81', RING_REACH)).toBeLessThanOrEqual(NO_RING_PIXEL_MAX_SHARE);
    });
  });
}

interface HintRing {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

interface HintBarState {
  rect: Rect;
  text: string;
  opacity: number;
  /** How far the text runs past the line's box (px), across and down. */
  overflow: { x: number; y: number };
  /** At points spread over the line's box: whether the line is the topmost element there, and is over the canvas. */
  stack: Array<{ lineOnTop: boolean; overCanvas: boolean }>;
  viewport: { width: number; height: number };
}

/**
 * The hint line (#hint-bar) as shown: its box, text, opacity and overflow,
 * and what is stacked at points over it. The line takes no taps
 * (pointer-events: none), which keeps it out of elementsFromPoint(); it is
 * let take hits for this one synchronous read, then put back, before any
 * frame is drawn.
 */
const hintBarState = (page: Page): Promise<HintBarState | null> =>
  page.evaluate(() => {
    const bar = document.getElementById('hint-bar');
    const canvas = document.getElementById('game-canvas');
    if (!bar || !canvas) return null;
    const style = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) return null;
    const before = bar.style.pointerEvents;
    bar.style.pointerEvents = 'auto';
    const stack: Array<{ lineOnTop: boolean; overCanvas: boolean }> = [];
    for (const fx of [0.05, 0.5, 0.95]) {
      for (const fy of [0.15, 0.5, 0.85]) {
        const at = document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        const line = at.findIndex((el) => el === bar || bar.contains(el));
        const under = at.indexOf(canvas);
        stack.push({ lineOnTop: line === 0, overCanvas: line >= 0 && under > line });
      }
    }
    bar.style.pointerEvents = before;
    return {
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      text: bar.textContent ?? '',
      opacity: Number(style.opacity),
      overflow: { x: bar.scrollWidth - bar.clientWidth, y: bar.scrollHeight - bar.clientHeight },
      stack,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });

/**
 * Whether two stroked circles' lines can meet: each line covers its radius
 * plus and minus half its width; the lines are apart when one circle lies
 * wholly outside the other, or wholly inside the other's inner edge.
 */
function strokesMeet(a: { x: number; y: number; radius: number; width: number }, b: { x: number; y: number; radius: number; width: number }): boolean {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const outer = (r: { radius: number; width: number }) => r.radius + r.width / 2;
  const inner = (r: { radius: number; width: number }) => r.radius - r.width / 2;
  if (d >= outer(a) + outer(b)) return false;
  if (d + outer(b) <= inner(a)) return false;
  if (d + outer(a) <= inner(b)) return false;
  return true;
}

// The first claim of a run shows the claimed-side hint, with its white ring
// around every Wisp, on the same tick; a first claim past half of the goal
// raises the surge level then too. Both rings sit on the same Wisp, so the
// surge ring (drawn under the hint's) must never share the hint ring's
// radius: checked from the radii and line widths the renderer drew with.
for (const vp of VIEWPORTS) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    const motion = reducedMotion === 'reduce' ? 'reduced motion' : 'full motion';
    test.describe(`the surge ring with the claimed-side hint at ${vp.width}x${vp.height}${vp.touch ? ' (touch)' : ''}, ${motion}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch, reducedMotion });

      test('stays clear of the hint ring on the same Wisp, in its own color, on the field, for as long as it shows', async ({ page }) => {
        await open(page, { line: true });
        await page.keyboard.press('Space');
        await advanceUntil(page, async () => (await view(page)).status === 'playing', 2_000, FRAME_MS);
        await advanceUntil(page, async () => (await view(page)).occupancy > 0, 10_000, FRAME_MS);
        await page.clock.runFor(FRAME_MS * 2);
        const cues = (await probe(page)).cues;
        expect(cues).toHaveLength(1);
        const first = await view(page);
        expect(first.status).toBe('playing');
        expect(first.occupancy).toBeGreaterThan(first.required / 2);
        expect(first.level).toBe(cues[0].level);
        let framesWithBoth = 0;
        let framesWithLineOpaque = 0;
        for (let guard = 0; guard < 200; guard++) {
          if ((await probe(page)).ticks >= cues[0].tick + WISP_SURGE_CUE_TICKS) break;
          const v = await view(page);
          const { hint, marks } = await page.evaluate(() => {
            type HintHook = { getHint: () => { id: string } | null; getHintMarks: () => { rings: HintRing[] } | null };
            const g = (window as unknown as { __game__: HintHook }).__game__;
            return { hint: g.getHint(), marks: g.getHintMarks() };
          });
          expect(v.status).toBe('playing');
          expect(hint?.id).toBe('claimSide');
          expect(v.rings).toHaveLength(v.heads.length);
          expect(marks?.rings ?? []).toHaveLength(v.heads.length);
          v.rings.forEach((ring, i) => {
            const hintRing = marks!.rings[i];
            // Both on the same Wisp's head.
            expect({ x: ring.x, y: ring.y }).toEqual({ x: hintRing.x, y: hintRing.y });
            expect(ring.color).toBe(cues[0].level === 1 ? '#ff6ad5' : '#ff3d81');
            for (const other of marks!.rings) {
              expect(
                strokesMeet({ ...ring, width: ring.lineWidth }, { ...other, width: HINT_RING_OUTLINE_WIDTH_PX }),
                `surge ring ${i} (r ${ring.radius}, w ${ring.lineWidth}) and hint ring (r ${other.radius}) at frame ${framesWithBoth}`
              ).toBe(false);
            }
          });
          framesWithBoth++;
          // On the field, clear of the HUD, PAUSE and the touch controls. The
          // hint line keeps away from the marker, not from the Wisps, so a
          // ring around a Wisp (the hint's own one too) may pass under it:
          // the line must stay whole and readable over the ring, and enough
          // of the ring must show around it.
          const { canvas, others } = await obstacles(page);
          const bar = await hintBarState(page);
          expect(bar, `hint line at frame ${framesWithBoth}`).not.toBeNull();
          expect(bar!.text.trim().length).toBeGreaterThan(0);
          expect(bar!.opacity).toBeGreaterThan(0);
          if (bar!.opacity === 1) framesWithLineOpaque++;
          // Whole: inside the window and the field, no text past its box.
          const viewportBox = { left: 0, top: 0, right: bar!.viewport.width, bottom: bar!.viewport.height };
          for (const box of [viewportBox, canvas]) {
            expect(inside({ x: bar!.rect.left, y: bar!.rect.top }, box)).toBe(true);
            expect(inside({ x: bar!.rect.right, y: bar!.rect.bottom }, box)).toBe(true);
          }
          expect(bar!.overflow.x).toBeLessThanOrEqual(0);
          expect(bar!.overflow.y).toBeLessThanOrEqual(0);
          // Over the canvas (so over the ring drawn on it), and nothing over it.
          expect(bar!.stack, `what is stacked over the hint line at frame ${framesWithBoth}`).toEqual(
            bar!.stack.map(() => ({ lineOnTop: true, overCanvas: true }))
          );
          for (const ring of v.rings) {
            const box = toPage(canvas, ringBox(ring));
            expect(box.right).toBeGreaterThan(box.left);
            expect(box.bottom).toBeGreaterThan(box.top);
            for (const { name, rect } of others) {
              if (name.startsWith('#hint-bar')) continue;
              expect(overlaps(box, rect), `${name} at frame ${framesWithBoth}`).toBe(false);
            }
            // Of the points evenly spread around the ring, the ones on the
            // field and under no box on the page (the hint line, the HUD,
            // PAUSE, the touch controls).
            const points = circlePoints(ring, ring.radius, RING_SAMPLES);
            const shown = points.filter((p) => onField(p) && !others.some(({ rect }) => inside(pointToPage(canvas, p), rect)));
            const share = shown.length / points.length;
            expect(share, `ring ${ring.x},${ring.y} r ${ring.radius} shown at frame ${framesWithBoth}`).toBeGreaterThanOrEqual(RING_SHOWN_MIN_SHARE);
          }
          await page.clock.runFor(FRAME_MS * 3);
        }
        expect(framesWithBoth).toBeGreaterThan(3);
        expect(framesWithLineOpaque).toBeGreaterThan(0);
      });
    });
  }
}
