// The in-play hints (src/hints/): a line over the field (#hint-bar) the
// first time a situation comes up, a mark on the field and, on a touch
// device, a glowing button. Runs on a faked page clock
// (tests/e2e/support/fakeClock.ts), so budgets are game time and tick counts
// are exact.
import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';
import { advanceUntil, loseAllLivesToIgniter } from './support/fakeClock';
interface HintMarks {
  rings: Array<{ x: number; y: number; radius: number; alpha: number }>;
  arrow: { x0: number; y0: number; x1: number; y1: number; alpha: number } | null;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getScore: () => number;
        getStage: () => number;
        getLives: () => number;
        getRemainingTicks: () => number;
        getTotalTicks: () => number;
        getGame: () => {
          getMarker: () => { getPosition: () => { x: number; y: number }; isDrawing: () => boolean };
          getWisps: () => Array<{ getPosition: () => { x: number; y: number } }>;
          getOccupancy: () => number;
          getGraceTicks: () => number;
          getIgniterPosition: () => { x: number; y: number } | null;
        };
      };
      getHint: () => { id: string; textKey: string; glow: string | null; age: number } | null;
      getHintMarks: () => HintMarks | null;
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const ALL_HINTS = ['draw', 'claimSide', 'slow', 'split', 'ember', 'blaze', 'igniter'];

const TEXT = {
  'en-US': {
    drawKey: 'HOLD SPACE + ARROW KEYS TO DRAW A LINE',
    drawTouch: 'HOLD FAST + A DIRECTION TO DRAW A LINE',
    claimSide: 'THE SIDE WITHOUT ENEMIES BECOMES YOURS',
    slowTouch: 'DRAW THE WHOLE LINE WITH SLOW FOR DOUBLE POINTS',
    longest: 'DRAW THE WHOLE LINE WITH SLOW FOR DOUBLE POINTS',
  },
  'ja-JP': {
    drawKey: 'Space を押しながら矢印キーで線を引こう',
    drawTouch: 'FAST を押しながら方向ボタンで線を引こう',
    claimSide: '敵のいない側が自分の陣地になる',
    slowTouch: 'SLOW だけで最後まで引くと点が 2 倍',
    longest: 'イグナイター: 線の途中で止まると追ってくる',
  },
} as const;

async function open(page: Page, query = '?seed=1'): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

async function start(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
const hint = (page: Page) => page.evaluate(() => window.__game__!.getHint());
const marks = (page: Page) => page.evaluate(() => window.__game__!.getHintMarks());
const barText = (page: Page) => page.locator('#hint-bar').evaluate((el) => (el as HTMLElement).style.display === 'none' ? '' : el.textContent ?? '');
const occupancy = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getOccupancy());

/** The scripted claim of tests/e2e/smoke.spec.ts on `?seed=1`: a small box under the top border. */
async function claimSmallBox(
  page: Page,
  drawKey = 'Space',
  whileDrawing?: () => Promise<void>,
  box: { from: number; to: number; depth?: number } = { from: 30, to: 55 }
): Promise<void> {
  const before = await occupancy(page);
  const walk = (await marker(page)).x > box.from ? 'ArrowLeft' : 'ArrowRight';
  await page.keyboard.down(walk);
  await advanceUntil(page, async () => ((x) => (walk === 'ArrowLeft' ? x <= box.from : x >= box.from))((await marker(page)).x), 4_000, FRAME_MS);
  await page.keyboard.up(walk);
  await page.keyboard.down(drawKey);
  await page.keyboard.down('ArrowDown');
  if (whileDrawing) {
    await advanceUntil(page, async () => (await marker(page)).y >= 4, 4_000, FRAME_MS);
    await whileDrawing();
  }
  await advanceUntil(page, async () => (await marker(page)).y >= (box.depth ?? 25), 4_000, FRAME_MS);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowRight');
  await advanceUntil(page, async () => (await marker(page)).x >= box.to, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowUp');
  await advanceUntil(page, async () => (await occupancy(page)) > before, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up(drawKey);
}

test.describe('the first play (en-US, 1280x800)', () => {
  test('shows draw until the first claim, then claimSide for 150 ticks; a reload shows neither', async ({ page }) => {
    await open(page);
    expect(await barText(page)).toBe('');
    await start(page);
    expect(await barText(page)).toBe(TEXT['en-US'].drawKey);
    expect(await page.locator('#hint-bar').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    // The arrow points down into the field from the marker on the top border.
    const arrow = (await marks(page))!.arrow!;
    expect(arrow.y1).toBeGreaterThan(arrow.y0);
    expect(arrow.x1).toBe(arrow.x0);
    // ...and is not drawn while the marker draws a line, the line staying.
    await claimSmallBox(page, 'Space', async () => {
      expect((await hint(page))!.id).toBe('draw');
      expect(await barText(page)).toBe(TEXT['en-US'].drawKey);
      expect(await marks(page)).toBeNull();
    });
    expect(await barText(page)).toBe(TEXT['en-US'].claimSide);
    const shownAt = await page.evaluate(() => window.__game__!.getHint()!.age);
    // The Wisp is ringed for the first 90 ticks.
    const wisps = await page.evaluate(() => window.__game__!.session.getGame().getWisps().map((w) => w.getPosition()));
    const ring = (await marks(page))!.rings;
    expect(ring).toHaveLength(wisps.length);
    expect(Math.abs(ring[0].x - (wisps[0].x + 0.5) * 4)).toBeLessThanOrEqual(8);
    await advanceUntil(page, async () => ((await hint(page))?.age ?? 999) >= 90, 3_000, FRAME_MS);
    expect((await hint(page))!.id).toBe('claimSide');
    expect(await marks(page)).toBeNull();
    // Gone 150 ticks after it appeared (ages 0-149).
    let lastAge = -1;
    await advanceUntil(
      page,
      async () => {
        const now = await hint(page);
        if (now?.id === 'claimSide') lastAge = now.age;
        return (await barText(page)) === '';
      },
      3_000,
      FRAME_MS
    );
    expect(shownAt).toBeLessThan(20);
    expect(lastAge).toBeGreaterThanOrEqual(140);
    expect(lastAge).toBeLessThanOrEqual(149);
    expect(await hint(page)).toBeNull();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('qixxx.hintsSeen') ?? '[]'))).toEqual(
      expect.arrayContaining(['draw', 'claimSide'])
    );

    await page.reload();
    await page.clock.runFor(100);
    await start(page);
    expect(await barText(page)).toBe('');
    await claimSmallBox(page);
    await page.clock.runFor(FRAME_MS * 2);
    expect(await barText(page)).toBe('');
  });
});

test.describe('the line over the field', () => {
  test('moves to the top while the marker is in the lower part of the field', async ({ page }) => {
    await open(page);
    await start(page);
    const position = () => page.locator('#hint-bar').evaluate((el) => (el as HTMLElement).dataset.position);
    expect(await position()).toBe('bottom');
    // Walk the border down the left edge to the bottom.
    await page.keyboard.down('ArrowLeft');
    await advanceUntil(page, async () => (await marker(page)).x === 0, 5_000, FRAME_MS);
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.down('ArrowDown');
    await advanceUntil(page, async () => (await marker(page)).y >= 100, 5_000, FRAME_MS);
    await page.keyboard.up('ArrowDown');
    await page.clock.runFor(FRAME_MS * 2);
    expect(await position()).toBe('top');
    const { bar, field } = await page.evaluate(() => ({
      bar: document.getElementById('hint-bar')!.getBoundingClientRect().toJSON(),
      field: document.getElementById('game-canvas')!.getBoundingClientRect().toJSON(),
    }));
    expect(bar.top - field.top).toBeLessThan(field.height * 0.1);
  });
});

async function layoutContext(browser: Browser, locale: string, viewport: { width: number; height: number }, hasTouch: boolean): Promise<BrowserContext> {
  return browser.newContext({ locale, viewport, hasTouch });
}

for (const viewport of [
  { width: 1280, height: 800, hasTouch: false },
  { width: 390, height: 844, hasTouch: true },
  { width: 844, height: 390, hasTouch: true },
  { width: 667, height: 375, hasTouch: true },
]) {
  for (const locale of ['en-US', 'ja-JP'] as const) {
    test(`the longest hint fits the field at ${viewport.width}x${viewport.height} (${locale}), at least 12px`, async ({ browser }) => {
      const context = await layoutContext(browser, locale, { width: viewport.width, height: viewport.height }, viewport.hasTouch);
      const page = await context.newPage();
      await open(page);
      await start(page);
      const sizeBefore = await page.evaluate(() => document.getElementById('game-canvas')!.getBoundingClientRect().toJSON());
      // Put the longest sentence in the line, in its own styles.
      const longest = TEXT[locale].longest;
      for (const top of [false, true]) {
        const box = await page.evaluate(
          ({ text, atTop }) => {
            const bar = document.getElementById('hint-bar')!;
            bar.textContent = text;
            if (atTop) {
              bar.style.top = '6%';
              bar.style.bottom = '';
            }
            const field = document.getElementById('game-canvas')!.getBoundingClientRect();
            const rect = bar.getBoundingClientRect();
            return { rect: rect.toJSON(), field: field.toJSON(), fontPx: parseFloat(getComputedStyle(bar).fontSize) };
          },
          { text: longest, atTop: top }
        );
        expect(box.rect.left).toBeGreaterThanOrEqual(box.field.left - 0.5);
        expect(box.rect.right).toBeLessThanOrEqual(box.field.right + 0.5);
        expect(box.rect.top).toBeGreaterThanOrEqual(box.field.top - 0.5);
        expect(box.rect.bottom).toBeLessThanOrEqual(box.field.bottom + 0.5);
        expect(box.fontPx).toBeGreaterThanOrEqual(12);
        // On a PC screen the line reads at the field's scale.
        if (viewport.width === 1280) expect(box.fontPx).toBeGreaterThanOrEqual(16);
        // A phone's line keeps its size: 13px, 12px on the smallest field.
        else expect(box.fontPx).toBe(viewport.width === 667 ? 12 : 13);
        // No more than a third of the field.
        expect(box.rect.height).toBeLessThanOrEqual(box.field.height / 3);
      }
      // The field keeps its size with the hint on.
      expect(await barText(page)).not.toBe('');
      const sizeAfter = await page.evaluate(() => document.getElementById('game-canvas')!.getBoundingClientRect().toJSON());
      expect(sizeAfter).toEqual(sizeBefore);
      await context.close();
    });
  }
}

for (const locale of ['en-US', 'ja-JP'] as const) {
  test.describe(`a touch device (${locale}, 390x844)`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 }, hasTouch: true });

    test('reads the touch sentences and lights FAST, then SLOW, leaving the press colour alone', async ({ page }) => {
      await open(page);
      await page.evaluate(() => localStorage.setItem('qixxx.hintsSeen', JSON.stringify(['claimSide', 'split', 'ember', 'blaze', 'igniter'])));
      await page.reload();
      await page.clock.runFor(100);
      await start(page);
      const fast = page.locator('#touch-controls button[data-code="Space"]');
      const slow = page.locator('#touch-controls button[data-code="KeyZ"]');
      const shadow = (button: typeof fast) => button.evaluate((el) => (el as HTMLElement).style.boxShadow);
      const background = (button: typeof fast) => button.evaluate((el) => (el as HTMLElement).style.background);
      expect(await barText(page)).toBe(TEXT[locale].drawTouch);
      expect(await shadow(fast)).not.toBe('');
      expect(await shadow(slow)).toBe('');
      // Pressing FAST still switches its background as before.
      const box = (await fast.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.clock.runFor(FRAME_MS);
      expect(await background(fast)).toBe('rgba(0, 255, 65, 0.35)');
      expect(await shadow(fast)).not.toBe('');
      await page.mouse.up();
      await page.clock.runFor(FRAME_MS);
      expect(await background(fast)).toBe('rgba(10, 14, 39, 0.7)');

      await claimSmallBox(page);
      expect(await shadow(fast)).toBe('');
      // The second claim makes the slow hint due.
      await claimSmallBox(page, 'Space', undefined, { from: 62, to: 76, depth: 8 });
      await page.clock.runFor(FRAME_MS * 2);
      expect(await barText(page)).toBe(TEXT[locale].slowTouch);
      expect(await shadow(slow)).not.toBe('');
      expect(await shadow(fast)).toBe('');
      // A slow-line claim ends it.
      await claimSmallBox(page, 'KeyZ', undefined, { from: 84, to: 98, depth: 8 });
      await page.clock.runFor(FRAME_MS * 2);
      expect(await barText(page)).toBe('');
      expect(await shadow(slow)).toBe('');
    });
  });
}

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the line, the arrow and the glow hold still', async ({ page }) => {
    await open(page);
    await start(page);
    const samples: string[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(
        JSON.stringify(
          await page.evaluate(() => ({
            opacity: document.getElementById('hint-bar')!.style.opacity,
            arrowAlpha: window.__game__!.getHintMarks()?.arrow?.alpha,
            glow: (document.querySelector('#touch-controls button[data-code="Space"]') as HTMLElement).style.boxShadow,
          }))
        )
      );
      await page.clock.runFor(FRAME_MS * 3);
    }
    expect(new Set(samples).size).toBe(1);
    expect(JSON.parse(samples[0]).opacity).toBe('1');
  });
});

test.describe('RESET HINTS (?debug)', () => {
  test('brings draw back on the next play', async ({ page }) => {
    await page.addInitScript((ids) => {
      if (sessionStorage.getItem('seeded') === null) {
        localStorage.setItem('qixxx.hintsSeen', JSON.stringify(ids));
        sessionStorage.setItem('seeded', '1');
      }
    }, ALL_HINTS);
    await open(page, '?seed=1&debug');
    // Every hint seen: a play shows none.
    await start(page);
    await page.clock.runFor(FRAME_MS * 4);
    expect(await barText(page)).toBe('');
    // Back on a fresh Title, RESET HINTS: the next play shows draw again.
    await page.reload();
    // The panel is a dynamic import: give it a moment of game time to mount.
    await advanceUntil(page, async () => (await page.locator('#debug-badge').count()) > 0, 5_000, 100);
    if (!(await page.locator('#debug-panel').isVisible())) await page.locator('#debug-badge').click();
    await page.getByRole('button', { name: 'RESET HINTS' }).click();
    expect(await page.evaluate(() => localStorage.getItem('qixxx.hintsSeen'))).toBeNull();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await start(page);
    await page.clock.runFor(FRAME_MS * 2);
    expect(await barText(page)).toBe(TEXT['en-US'].drawKey);
  });
});

test.describe('the hints do not change the run', () => {
  // The same seed and the same key script, once with nothing seen (every
  // hint comes up) and once with every hint seen (none does): the run must
  // read the same at every checkpoint. The script makes two claims (the
  // second raising the slow hint) and stops mid-line until the Igniter
  // appears (and burns the marker), on a fixed tick schedule.
  async function runScript(
    page: Page,
    seen: string[]
  ): Promise<{ checkpoints: string[]; hintsShown: string[]; claims: number; scoreRises: number; igniterSeen: boolean }> {
    // The seen hints are in place before the page loads.
    await page.addInitScript((ids) => {
      if (ids.length > 0) localStorage.setItem('qixxx.hintsSeen', JSON.stringify(ids));
    }, seen);
    await open(page);
    // Every live tick (hit-stopped ones included) goes through fx.tick():
    // counting them lets each key land right after the same tick in both
    // runs, whatever the frame phase.
    //
    // What the script did is watched in the page, at the end of every frame
    // (after each requestAnimationFrame callback, so after the frame's
    // render): the hint line's text, each claim raising the occupancy (and
    // the score) once, and the Igniter showing on the field. The test reads
    // the record once at the end, so the clock can run in long stretches.
    await page.evaluate(() => {
      const g = window.__game__!;
      const fx = (g as unknown as { fx: { tick: () => void } }).fx;
      const w = window as unknown as { __ticks__: number; __watch__: unknown };
      w.__ticks__ = 0;
      const tick = fx.tick.bind(fx);
      fx.tick = () => {
        w.__ticks__++;
        tick();
      };
      const watch = { hintsShown: [] as string[], claims: 0, scoreRises: 0, igniterSeen: false };
      w.__watch__ = watch;
      let last = { status: 'title', occupancy: 0, score: 0 };
      const bar = document.getElementById('hint-bar')!;
      const observe = () => {
        const text = bar.style.display === 'none' ? '' : bar.textContent ?? '';
        if (text !== '' && !watch.hintsShown.includes(text)) watch.hintsShown.push(text);
        const s = g.session;
        const game = s.getGame();
        const now = { status: s.getStatus(), occupancy: game.getOccupancy(), score: s.getScore() };
        if (now.status === 'playing' && last.status === 'playing') {
          if (now.occupancy > last.occupancy) watch.claims++;
          if (now.score > last.score) watch.scoreRises++;
        }
        if (game.getIgniterPosition() !== null) watch.igniterSeen = true;
        last = now;
      };
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          callback(time);
          observe();
        });
    });
    const ticks = () => page.evaluate(() => (window as unknown as { __ticks__: number }).__ticks__);
    const checkpoints: string[] = [];
    const snapshot = async (label: string) => {
      const state = await page.evaluate(() => {
        const s = window.__game__!.session;
        const g = s.getGame();
        return {
          status: s.getStatus(),
          score: s.getScore(),
          stage: s.getStage(),
          lives: s.getLives(),
          occupancy: g.getOccupancy(),
          marker: g.getMarker().getPosition(),
          remaining: s.getRemainingTicks(),
        };
      });
      checkpoints.push(`${label} ${JSON.stringify(state)}`);
    };
    // Advances `n` counted ticks and stops right after the frame that runs
    // the n-th. A 16ms frame runs at most one 16.7ms tick, so `left` frames
    // at once (the clock's frames sit on a 16ms grid) run at most the `left`
    // ticks still due: never past the target, and they reach it only on
    // their last frame. Repeating that until the target is reached stops on
    // the same frame as stepping a frame at a time would, in a few calls.
    const hold = async (n: number) => {
      if (n === 0) return;
      const target = (await ticks()) + n;
      for (let left = n; left > 0; left = target - (await ticks())) await page.clock.runFor(FRAME_MS * left);
    };
    // [key, down/up, ticks before]. The marker moves about a cell a tick.
    const script: Array<[string, 'down' | 'up', number]> = [
      ['Enter', 'down', 0], ['Enter', 'up', 4],
      // Claim 1: a box under the top border.
      ['ArrowLeft', 'down', 24], ['ArrowLeft', 'up', 50],
      ['Space', 'down', 0], ['ArrowDown', 'down', 0], ['ArrowDown', 'up', 25],
      ['ArrowRight', 'down', 0], ['ArrowRight', 'up', 25],
      ['ArrowUp', 'down', 0], ['ArrowUp', 'up', 36], ['Space', 'up', 0],
      // Claim 2: a shallow box further right.
      ['ArrowRight', 'down', 18], ['ArrowRight', 'up', 10],
      ['Space', 'down', 0], ['ArrowDown', 'down', 0], ['ArrowDown', 'up', 8],
      ['ArrowRight', 'down', 0], ['ArrowRight', 'up', 14],
      ['ArrowUp', 'down', 0], ['ArrowUp', 'up', 18], ['Space', 'up', 0],
      // A line part way in, then standing still on it: the Igniter.
      ['ArrowRight', 'down', 18], ['ArrowRight', 'up', 24],
      ['Space', 'down', 0], ['ArrowDown', 'down', 0], ['ArrowDown', 'up', 12], ['Space', 'up', 0],
      ['ArrowLeft', 'down', 240], ['ArrowLeft', 'up', 4],
    ];
    let step = 0;
    for (const [key, action, waitBefore] of script) {
      await hold(waitBefore);
      if (action === 'down') await page.keyboard.down(key);
      else await page.keyboard.up(key);
      if (++step % 4 === 0) await snapshot(`step ${step}`);
    }
    await hold(120);
    await snapshot('end');
    const watched = await page.evaluate(
      () => (window as unknown as { __watch__: { hintsShown: string[]; claims: number; scoreRises: number; igniterSeen: boolean } }).__watch__
    );
    return { checkpoints, ...watched };
  }

  test('reads the same with every hint shown and with none', async ({ browser }) => {
    // Each run has its own context (its own storage) and its own faked
    // clock, so the two run side by side.
    const [first, second] = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
    const [shown, quiet] = await Promise.all([runScript(first, []), runScript(second, ALL_HINTS)]);
    expect(shown.hintsShown).toEqual(
      expect.arrayContaining([TEXT['en-US'].drawKey, TEXT['en-US'].claimSide, 'IGNITER: CHASES YOU WHEN YOU STOP ON A LINE'])
    );
    expect(shown.hintsShown.length).toBeGreaterThanOrEqual(3);
    expect(quiet.hintsShown).toEqual([]);
    expect(quiet.checkpoints).toEqual(shown.checkpoints);
    // The script did what it says, in both runs: two claims or more (the
    // occupancy and the score each rising twice or more), and the Igniter came.
    for (const run of [shown, quiet]) {
      expect(run.claims).toBeGreaterThanOrEqual(2);
      expect(run.scoreRises).toBeGreaterThanOrEqual(2);
      expect(run.igniterSeen).toBe(true);
    }
    expect(quiet.claims).toBe(shown.claims);
    const end = JSON.parse(shown.checkpoints.at(-1)!.replace(/^end /, '')) as { score: number; lives: number };
    expect(end.score).toBeGreaterThan(0);
    await first.context().close();
    await second.context().close();
  });
});
