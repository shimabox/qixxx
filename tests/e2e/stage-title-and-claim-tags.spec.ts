// The stage title (STAGE n and the stage's name) as each stage starts, and
// BIG CLAIM / CLOSE CALL next to a claim's score. On a faked page clock
// (tests/e2e/support/fakeClock.ts): ticks are counted by wrapping fx.tick(),
// which main.ts calls once per live tick, so nothing waits on the wall clock.
//
// Where the texts are drawn comes from the renderer itself
// (window.__game__.getFxTextBoxes(), logical canvas px), mapped onto the page
// through the canvas's own box, and is checked against the boxes of the HUD,
// the PAUSE button and the hint line — no pixel constant of a font.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil } from './support/fakeClock';
import { buildStageScript } from '../../src/core/scriptedRun';
import { sessionAtStage } from '../../src/core/stageStartFixture';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Point {
  x: number;
  y: number;
}
interface ClaimNotice {
  claimedCells: number;
  occupancyBefore: number;
  occupancyAfter: number;
  lineSpeed: 'fast' | 'slow';
  areaScore: number;
  bigClaim: boolean;
  nearMissBonus: number;
  stageClearBonus: number;
  multiplier: number;
  split: boolean;
  splitMultiplierGain: number;
  stageCleared: boolean;
  closedLine: Point[];
}
interface FrameView {
  stageTitle: { heading: string; title: string; age: number; scale: number; alpha: number } | null;
  claimTags: Array<{ tags: Array<{ kind: string; text: string }>; revealId: number }>;
  popups: Array<{ text: string; revealId: number }>;
}
interface Probe {
  ticks: number;
  stageStarts: Array<{ tick: number; heading: string; title: string }>;
  claims: Array<{ tick: number; notice: ClaimNotice }>;
}
interface Segment {
  dx: number;
  dy: number;
  drawHeld: boolean;
  slow: boolean;
  ticks: number;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getStage: () => number;
        getStageTicks: () => number;
        getTotalTicks: () => number;
        update: (input: { dx: number; dy: number; drawHeld: boolean; slow?: boolean; confirm: boolean }) => void;
        getMarkerStart: () => { edge: 'top' | 'bottom' | 'left' | 'right'; point: Point } | null;
        applyDebugOverrides: (overrides: { requiredOccupancy?: number }) => void;
        resetDebugOverrides: () => void;
        getGame: () => { getWisps: () => unknown[] };
      };
      fx: {
        tick: () => void;
        getFrame: () => FrameView;
        onStageStart: (heading: string, title: string) => void;
        onClaim: (notice: ClaimNotice, context: { nextMultiplier: number }) => { hitStopTicks: number; chain: number };
      };
      getFxTextBoxes: () => { stageTitle: Box | null; claimTags: Box[] };
    };
    __probe__?: Probe;
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const CANVAS_W = 640;
const CANVAS_H = 480;

/** Loads the page on a paused fake clock and counts fx ticks, stage starts and claims. */
async function open(page: Page, query: string): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
  await page.evaluate(() => {
    const g = window.__game__!;
    const probe: Probe = { ticks: 0, stageStarts: [], claims: [] };
    const tick = g.fx.tick.bind(g.fx);
    g.fx.tick = () => {
      probe.ticks++;
      tick();
    };
    const onStageStart = g.fx.onStageStart.bind(g.fx);
    g.fx.onStageStart = (heading, title) => {
      probe.stageStarts.push({ tick: probe.ticks, heading, title });
      onStageStart(heading, title);
    };
    const onClaim = g.fx.onClaim.bind(g.fx);
    g.fx.onClaim = (notice, context) => {
      probe.claims.push({ tick: probe.ticks, notice });
      return onClaim(notice, context);
    };
    window.__probe__ = probe;
  });
}

const probe = (page: Page) => page.evaluate(() => window.__probe__!);
const frame = (page: Page) => page.evaluate(() => window.__game__!.fx.getFrame());
const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());

/** Runs the clock until `n` more fx ticks have passed. */
async function runTicks(page: Page, n: number): Promise<void> {
  const target = (await probe(page)).ticks + n;
  await advanceUntil(page, async () => (await probe(page)).ticks >= target, n * 40 + 1000, 4);
}

/** The drawn boxes, the canvas and the HUD / PAUSE / hint line, all as page rects. */
async function layout(page: Page): Promise<{
  title: Rect | null;
  tags: Rect[];
  canvas: Rect;
  others: Array<{ name: string; rect: Rect }>;
}> {
  return page.evaluate(
    ({ w, h }) => {
      const toRect = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const canvas = document.getElementById('game-canvas')!.getBoundingClientRect();
      const map = (b: { x: number; y: number; width: number; height: number }) => ({
        left: canvas.left + (b.x * canvas.width) / w,
        top: canvas.top + (b.y * canvas.height) / h,
        right: canvas.left + ((b.x + b.width) * canvas.width) / w,
        bottom: canvas.top + ((b.y + b.height) * canvas.height) / h,
      });
      const boxes = window.__game__!.getFxTextBoxes();
      const others: Array<{ name: string; rect: { left: number; top: number; right: number; bottom: number } }> = [];
      for (const id of ['hud-row', 'pause-button', 'hint-bar']) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (getComputedStyle(el).display === 'none' || r.width === 0 || r.height === 0) continue;
        others.push({ name: id, rect: toRect(r) });
      }
      return {
        title: boxes.stageTitle ? map(boxes.stageTitle) : null,
        tags: boxes.claimTags.map(map),
        canvas: toRect(canvas),
        others,
      };
    },
    { w: CANVAS_W, h: CANVAS_H }
  );
}

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** On the field, and clear of the HUD, the PAUSE button and the hint line. */
function expectPlaced(label: string, box: Rect, l: Awaited<ReturnType<typeof layout>>): void {
  const eps = 0.5;
  expect(box.left, `${label} left`).toBeGreaterThanOrEqual(l.canvas.left - eps);
  expect(box.right, `${label} right`).toBeLessThanOrEqual(l.canvas.right + eps);
  expect(box.top, `${label} top`).toBeGreaterThanOrEqual(l.canvas.top - eps);
  expect(box.bottom, `${label} bottom`).toBeLessThanOrEqual(l.canvas.bottom + eps);
  for (const other of l.others) expect(overlaps(box, other.rect), `${label} over ${other.name}`).toBe(false);
}

// The comb of core/scriptedRun.ts's buildStageScript() on the full field,
// from stage 3's start: walk the border to near the top-left corner, then
// vertical lines 3 columns apart, every third one slow. Stages 1 and 2 are
// cleared the way core/stageStartFixture.ts's sessionAtStage() clears them,
// so the run is the one played headlessly there — on seed 636 stage 3 starts
// on the right edge, its comb's claim at stage tick 1790 is a close call (not
// a big claim) and its claim at stage tick 1912, a split that clears stage 3,
// is a big claim and a close call.
const SPLIT_SEED = 636;
function stage3Comb(seed: number): Segment[] {
  const start = sessionAtStage(3, { seed }).getMarkerStart()!.point;
  return buildStageScript(160, 120, start).map((s) => ({ ...s, ticks: Number.isFinite(s.ticks) ? s.ticks : 1e9 }));
}

/**
 * Makes the live session play stages 1 to `boxThrough` by a small box drawn
 * straight in from the stage's start, along the edge and back out, with the
 * goal lowered by a debug override (core/stageStartFixture.ts's
 * clearFromStart()), and, given `comb`, the stage after them by the comb,
 * with the override dropped at its first tick. Every other stage, and
 * StageClear, still take the keys.
 *
 * With `boxes` above 1, each of those stages is played by that many boxes in
 * a row along the edge, all fast lines: the goal stays out of reach (a debug
 * override too) until the last box begins, so only the last one clears.
 */
async function drive(page: Page, boxThrough: number, comb: Segment[] | null = null, boxes = 1): Promise<void> {
  await page.evaluate(
    ({ boxThrough, comb, boxes }) => {
      const session = window.__game__!.session;
      const update = session.update.bind(session);
      const inward = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] } as const;
      session.update = (input) => {
        if (session.getStatus() !== 'playing') return update(input);
        const stage = session.getStage();
        const tick = session.getStageTicks();
        if (stage <= boxThrough) {
          const boxTicks = 6;
          if (tick % boxTicks === 0 && tick < boxTicks * boxes) {
            const last = Math.floor(tick / boxTicks) >= boxes - 1;
            session.applyDebugOverrides({ requiredOccupancy: last ? 0.00001 : 0.99 });
          }
          const [ix, iy] = inward[session.getMarkerStart()!.edge];
          const along = ix === 0 ? [1, 0] : [0, 1];
          const box = [[ix, iy], [ix, iy], along, along, [-ix, -iy], [-ix, -iy]];
          const [dx, dy] = tick < boxTicks * boxes ? box[tick % boxTicks] : [0, 0];
          return update({ dx, dy, drawHeld: true, slow: false, confirm: false });
        }
        if (comb && stage === boxThrough + 1) {
          if (tick === 0) session.resetDebugOverrides();
          let remaining = tick;
          for (const s of comb) {
            if (remaining < s.ticks) return update({ dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false });
            remaining -= s.ticks;
          }
          return update({ dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false });
        }
        return update(input);
      };
    },
    { boxThrough, comb, boxes }
  );
}

/** From STAGE CLEAR, confirms on to the next stage and runs until its first tick (its title shown). */
async function toNextStage(page: Page): Promise<void> {
  const count = (await probe(page)).stageStarts.length;
  await advanceUntil(page, async () => (await status(page)) === 'stageclear', 60_000, 20);
  // A confirm completes the result's count-up (if still counting), the next starts the stage.
  await page.clock.runFor(1_500);
  for (let i = 0; i < 4 && (await probe(page)).stageStarts.length <= count; i++) {
    await page.keyboard.press('Enter');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > count || (await status(page)) === 'stageclear', 300, 4);
    if ((await probe(page)).stageStarts.length <= count) await page.clock.runFor(200);
  }
  await advanceUntil(page, async () => (await probe(page)).stageStarts.length > count, 2_000, 4);
}

const wispCount = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getWisps().length);

test.describe('the stage title', () => {
  test('STAGE 1 WARM-UP shows from the start of play for 60 ticks, then goes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '?seed=1');
    expect((await frame(page)).stageTitle).toBeNull();
    await page.keyboard.press('Space'); // Title -> Playing
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    const start = (await probe(page)).stageStarts[0];
    expect(start).toMatchObject({ heading: 'STAGE 1', title: 'WARM-UP' });
    await page.clock.runFor(4); // a frame drawn
    const shown = await frame(page);
    expect(shown.stageTitle).toMatchObject({ heading: 'STAGE 1', title: 'WARM-UP' });
    expect(await status(page)).toBe('playing'); // play does not wait for it
    const l = await layout(page);
    expect(l.title).not.toBeNull();
    expectPlaced('title', l.title!, l);

    // Shown on every tick up to the 60th from its start, gone from it.
    await advanceUntil(page, async () => (await probe(page)).ticks >= start.tick + 59, 3000, 4);
    expect((await frame(page)).stageTitle?.age).toBe(59);
    await advanceUntil(page, async () => (await probe(page)).ticks >= start.tick + 60, 1000, 4);
    expect((await frame(page)).stageTitle).toBeNull();
    await page.clock.runFor(20);
    expect((await page.evaluate(() => window.__game__!.getFxTextBoxes())).stageTitle).toBeNull();
  });

  test('later stages open with their own titles: SPRINTER (one Wisp) on stage 2, FAST PAIR (two) on stage 3', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '?seed=1');
    await drive(page, 2);
    await page.keyboard.press('Space');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    expect(await wispCount(page)).toBe(1);

    await toNextStage(page);
    expect((await probe(page)).stageStarts.at(-1)).toMatchObject({ heading: 'STAGE 2', title: 'SPRINTER' });
    await page.clock.runFor(20);
    expect((await frame(page)).stageTitle).toMatchObject({ heading: 'STAGE 2', title: 'SPRINTER' });
    expect(await wispCount(page)).toBe(1);

    await toNextStage(page);
    expect((await probe(page)).stageStarts.at(-1)).toMatchObject({ heading: 'STAGE 3', title: 'FAST PAIR' });
    await page.clock.runFor(20);
    expect((await frame(page)).stageTitle).toMatchObject({ heading: 'STAGE 3', title: 'FAST PAIR' });
    expect(await wispCount(page)).toBe(2);
  });

  test('reads in Japanese on the Japanese page', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await open(page, '?seed=1');
    await drive(page, 2);
    await page.keyboard.press('Space');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    await page.clock.runFor(20);
    expect((await frame(page)).stageTitle).toMatchObject({ heading: 'STAGE 1', title: 'はじまり' });
    const l = await layout(page);
    expectPlaced('title', l.title!, l);

    await toNextStage(page);
    await page.clock.runFor(20);
    expect((await frame(page)).stageTitle).toMatchObject({ heading: 'STAGE 2', title: '速い 1 匹' });
    await toNextStage(page);
    await page.clock.runFor(20);
    expect((await frame(page)).stageTitle).toMatchObject({ heading: 'STAGE 3', title: '速い 2 匹' });
    await context.close();
  });

  // Stage 2's title, in English and in Japanese, on the field and clear of
  // the HUD, the PAUSE button and the hint line, on a PC screen and on phones.
  // Stage 1 is cleared on its second fast line, so stage 2 opens with the
  // slow line's hint (due from a run's second claim) shown with the title.
  for (const { viewport, touch } of [
    { viewport: { width: 1280, height: 800 }, touch: false },
    { viewport: { width: 390, height: 844 }, touch: true },
    { viewport: { width: 844, height: 390 }, touch: true },
    { viewport: { width: 667, height: 375 }, touch: true },
  ]) {
    for (const { locale, title, slowHint } of [
      { locale: 'en-US', title: 'SPRINTER', slowHint: touch ? 'DRAW THE WHOLE LINE WITH SLOW FOR DOUBLE POINTS' : 'DRAW THE WHOLE LINE WITH SHIFT FOR DOUBLE POINTS' },
      { locale: 'ja-JP', title: '速い 1 匹', slowHint: touch ? 'SLOW だけで最後まで引くと点が 2 倍' : 'Shift を押したまま最後まで引くと点が 2 倍' },
    ]) {
      test(`stage 2's title (${locale}) at ${viewport.width}x${viewport.height}${touch ? ' (touch)' : ''} stays on the field, clear of the HUD, PAUSE and the hint`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ locale, viewport, hasTouch: touch });
        const page = await context.newPage();
        await open(page, '?seed=1');
        await drive(page, 1, null, 2);
        await page.keyboard.press('Space');
        await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
        await toNextStage(page);
        const stage1Claims = (await probe(page)).claims.map((c) => c.notice);
        expect(stage1Claims.map((n) => [n.lineSpeed, n.stageCleared])).toEqual([
          ['fast', false],
          ['fast', true],
        ]);
        // Over the whole time it is shown, as it pops in and settles.
        const start = (await probe(page)).stageStarts.at(-1)!;
        expect(start).toMatchObject({ heading: 'STAGE 2', title });
        for (const age of [2, 10, 30, 58]) {
          await advanceUntil(page, async () => (await probe(page)).ticks >= start.tick + age, 2_000, 4);
          await page.clock.runFor(4); // a frame drawn
          expect((await frame(page)).stageTitle, `age ${age}`).toMatchObject({ heading: 'STAGE 2', title });
          await expect(page.locator('#hint-bar'), `age ${age}`).toBeVisible();
          await expect(page.locator('#hint-bar'), `age ${age}`).toHaveText(slowHint);
          // The PAUSE button is shown on touch screens only.
          if (touch) await expect(page.locator('#pause-button'), `age ${age}`).toBeVisible();
          const l = await layout(page);
          expect(l.title, `age ${age}`).not.toBeNull();
          expect(l.others.map((o) => o.name), `age ${age}`).toEqual(
            expect.arrayContaining(touch ? ['hud-row', 'pause-button', 'hint-bar'] : ['hud-row', 'hint-bar'])
          );
          expectPlaced(`title at age ${age}`, l.title!, l);
        }
        await context.close();
      });
    }
  }

  test('is shown with reduced motion, without moving', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await open(page, '?seed=1');
    await page.keyboard.press('Space');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    for (let i = 0; i < 5; i++) {
      await page.clock.runFor(100);
      expect((await frame(page)).stageTitle ?? { scale: 1, alpha: 1 }).toMatchObject({ scale: 1, alpha: 1 });
    }
    await context.close();
  });

  test('does not run on while paused', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '?seed=1');
    await page.keyboard.press('Space');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    await page.clock.runFor(100);
    const before = (await frame(page)).stageTitle!.age;
    await page.keyboard.press('KeyP');
    await page.clock.runFor(2_000);
    expect((await frame(page)).stageTitle?.age).toBe(before);
    await page.keyboard.press('KeyP');
    await page.clock.runFor(100);
    expect((await frame(page)).stageTitle!.age).toBeGreaterThan(before);
  });
});

test.describe('BIG CLAIM and CLOSE CALL', () => {
  test(`show next to the claims they belong to (seed ${SPLIT_SEED}, stage 3)`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, `?seed=${SPLIT_SEED}`);
    await drive(page, 2, stage3Comb(SPLIT_SEED));
    await page.keyboard.press('Space');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    await toNextStage(page);
    await toNextStage(page);
    expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(3);
    const stage3Start = (await probe(page)).stageStarts.at(-1)!.tick;
    const stage3Claims = async () => (await probe(page)).claims.filter((c) => c.tick >= stage3Start);

    // Stage tick 1790: a close call, not a big claim — CLOSE CALL +200 under its score.
    await advanceUntil(page, async () => (await stage3Claims()).some((c) => c.notice.nearMissBonus > 0), 60_000, 20);
    await page.clock.runFor(20);
    const closeCall = (await stage3Claims()).find((c) => c.notice.nearMissBonus > 0)!.notice;
    expect(closeCall).toMatchObject({ bigClaim: false, nearMissBonus: 200, split: false });
    let f = await frame(page);
    expect(f.claimTags).toHaveLength(1);
    expect(f.claimTags[0].tags).toEqual([{ kind: 'close', text: 'CLOSE CALL +200' }]);
    expect(f.popups.map((p) => p.revealId)).toContain(f.claimTags[0].revealId);
    let l = await layout(page);
    expect(l.tags).toHaveLength(1);
    expectPlaced('CLOSE CALL', l.tags[0], l);

    // Stage tick 1912: the split that clears stage 3 is a big claim and a close call.
    await advanceUntil(page, async () => (await stage3Claims()).some((c) => c.notice.split), 30_000, 20);
    await page.clock.runFor(20);
    const big = (await stage3Claims()).find((c) => c.notice.split)!.notice;
    expect(big).toMatchObject({ bigClaim: true, nearMissBonus: 200, split: true, stageCleared: true });
    expect(await status(page)).toBe('stageclear');
    f = await frame(page);
    expect(f.claimTags.at(-1)!.tags).toEqual([
      { kind: 'big', text: 'BIG CLAIM' },
      { kind: 'close', text: 'CLOSE CALL +200' },
    ]);
    l = await layout(page);
    for (const box of l.tags) expectPlaced('BIG CLAIM', box, l);
  });
});

// The phone layouts: the title as play starts (with the first hint on), and
// BIG CLAIM / CLOSE CALL for made-up claims at the field's corners and
// middle — the worst places for them — kept on the field and clear of the
// HUD, the PAUSE button and the hint line.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 667, height: 375 },
]) {
  test(`at ${viewport.width}x${viewport.height} (touch) the title and the tags stay on the field, clear of the HUD, PAUSE and the hint`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    await open(page, '?seed=1');
    await page.keyboard.press('Space');
    await advanceUntil(page, async () => (await probe(page)).stageStarts.length > 0, 1000, 4);
    await page.clock.runFor(100);
    await expect(page.locator('#hint-bar')).toBeVisible();
    await expect(page.locator('#pause-button')).toBeVisible();
    let l = await layout(page);
    expect(l.title).not.toBeNull();
    expectPlaced('title', l.title!, l);

    for (const [name, line, split] of [
      ['top-left', [{ x: 2, y: 1 }, { x: 2, y: 2 }], false],
      ['bottom-right', [{ x: 157, y: 117 }, { x: 157, y: 118 }], false],
      ['bottom-left', [{ x: 2, y: 117 }, { x: 2, y: 118 }], false],
      ['middle', [{ x: 80, y: 60 }, { x: 80, y: 61 }], false],
      ['split', [{ x: 80, y: 60 }, { x: 80, y: 61 }], true],
    ] as const) {
      await page.evaluate(({ closedLine, split }) => {
        window.__game__!.fx.onClaim(
          {
            claimedCells: 4000,
            occupancyBefore: 0,
            occupancyAfter: 0.2,
            lineSpeed: 'fast',
            areaScore: 3000,
            bigClaim: true,
            nearMissBonus: 200,
            stageClearBonus: 0,
            multiplier: 1,
            split,
            splitMultiplierGain: split ? 1 : 0,
            stageCleared: split,
            closedLine,
          },
          { nextMultiplier: 2 }
        );
      }, { closedLine: line as unknown as Point[], split });
      await runTicks(page, 12);
      l = await layout(page);
      expect(l.tags.length, name).toBeGreaterThan(0);
      for (const box of l.tags) expectPlaced(`tags ${name}`, box, l);
      await runTicks(page, 60);
    }
    await context.close();
  });
}
