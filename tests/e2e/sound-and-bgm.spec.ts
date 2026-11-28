// The debug panel's SOUND section (level sliders, SOUND TEST, EXPORT / RESET)
// and the music (src/audio/bgm.ts): playing in live play whenever the SOUND
// button is ON, on every page, following the live run on the audio clock; the
// panel's BGM switch (on on every page load) silences it alone. The music
// specs run on a stand-in AudioContext whose clock is the faked page clock
// (tests/e2e/support/fakeAudio.ts).
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil, finishGameOverResult, loseAllLivesToIgniter } from './support/fakeClock';
import { installFakeAudio, setPageHidden } from './support/fakeAudio';

interface Point {
  x: number;
  y: number;
}

interface BgmStateView {
  enabled: boolean;
  playing: boolean;
  generation: number;
  track: string;
  intensity: number;
  bpm: number;
  scheduled: number;
  step: number;
  liveNodes: number;
  lastBatch: { min: number; max: number; now: number; count: number } | null;
  lastStop: { generation: number; at: number; end: number } | null;
}

interface GameHandle {
  session: {
    getStatus: () => string;
    getScore: () => number;
    getStage: () => number;
    getLives: () => number;
    getTotalTicks: () => number;
    getRemainingTicks: () => number;
    isRunTainted: () => boolean;
    setDebugTimeLimitTicks: (ticks: number) => void;
    applyDebugOverrides: (o: Record<string, number>) => void;
    getGame: () => { getMarker: () => { getPosition: () => Point } };
    getMarkerStart: () => { edge: 'top' | 'right' | 'bottom' | 'left'; point: Point } | null;
  };
  getSfxLog: () => string[];
  getBgmState: () => BgmStateView;
  getPlayLog: () => unknown[];
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24;
const LOOKAHEAD = 0.2; // BGM_LOOKAHEAD_SEC
const STEP = 60 / 126 / 4; // one sixteenth at TENSE's 126 BPM (the first stage's tune)

async function pinNormalSeed(page: Page, seed: number): Promise<void> {
  await page.addInitScript((value: number) => {
    const real = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = ((array: ArrayBufferView | null) => {
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = value;
        return array;
      }
      return real(array as never);
    }) as Crypto['getRandomValues'];
  }, seed);
}

async function soundOn(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('qixxx.muted', 'false'));
}

async function failRankingCheck(page: Page): Promise<void> {
  await page.route('**/api/ranking', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
}

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

async function openDebug(page: Page, query = ''): Promise<void> {
  await open(page, `?debug${query}`);
  await advanceUntil(page, () => page.locator('#debug-sound-section').isVisible(), 2_000, 100);
}

const status = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStatus());
const bgmState = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.getBgmState());
const sfxLog = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.getSfxLog());
const marker = (page: Page) =>
  page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getGame().getMarker().getPosition());
const score = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore());
const audioNow = (page: Page) => page.evaluate(() => new AudioContext().currentTime);
const starts = (page: Page) => page.evaluate(() => [...(window.__fakeAudio__?.starts ?? [])]);
const noiseSources = (page: Page) => page.evaluate(() => window.__fakeAudio__?.sources ?? 0);
const playLogRuns = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.getPlayLog());

async function start(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

async function claimSmallBox(page: Page): Promise<void> {
  const before = await score(page);
  await page.keyboard.down('ArrowLeft');
  await advanceUntil(page, async () => (await marker(page)).x <= 30, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowDown');
  await advanceUntil(page, async () => (await marker(page)).y >= 25, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowRight');
  await advanceUntil(page, async () => (await marker(page)).x >= 55, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowUp');
  await advanceUntil(page, async () => (await score(page)) > before, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
}

// Clears the live stage (with a tiny required occupancy set beforehand) the
// way claimSmallBox() does, but steered from inside the page on the faked
// clock: a timer reads the marker every 16ms of game time and presses and
// releases the keys itself, so the whole claim is a few clock runs, not a
// read per frame. Every key is up again once the stage is cleared.
async function clearStage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const session = (window as unknown as { __game__: GameHandle }).__game__.session;
    const key = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const before = session.getScore();
    const start = session.getMarkerStart();
    // From the top (its middle, where stage 1 starts): along the top to x
    // 30, then the box. From the middle of any other edge (later stages
    // start on any edge): the same 25-cell box, drawn straight in from the
    // start, along the edge (right on the bottom, down on the sides) and
    // back out.
    const arrows = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' } as const;
    let plan: Array<{ down: string[]; up: string[]; done: (p: Point) => boolean }>;
    if (!start || start.edge === 'top') {
      plan = [
        { down: ['ArrowLeft'], up: ['ArrowLeft'], done: (p) => p.x <= 30 },
        { down: ['Space', 'ArrowDown'], up: ['ArrowDown'], done: (p) => p.y >= 25 },
        { down: ['ArrowRight'], up: ['ArrowRight'], done: (p) => p.x >= 55 },
        { down: ['ArrowUp'], up: ['ArrowUp', 'Space'], done: () => session.getScore() > before },
      ];
    } else {
      const o = start.point;
      const vertical = start.edge === 'bottom';
      const inward = vertical ? arrows.up : start.edge === 'left' ? arrows.right : arrows.left;
      const outward = vertical ? arrows.down : start.edge === 'left' ? arrows.left : arrows.right;
      const along = vertical ? arrows.right : arrows.down;
      const depth = (p: Point) => (vertical ? Math.abs(p.y - o.y) : Math.abs(p.x - o.x));
      const side = (p: Point) => (vertical ? Math.abs(p.x - o.x) : Math.abs(p.y - o.y));
      plan = [
        { down: ['Space', inward], up: [inward], done: (p) => depth(p) >= 25 },
        { down: [along], up: [along], done: (p) => side(p) >= 25 },
        { down: [outward], up: [outward, 'Space'], done: () => session.getScore() > before },
      ];
    }
    let i = 0;
    let pressed = false;
    const timer = window.setInterval(() => {
      if (session.getStatus() !== 'playing' || i >= plan.length) {
        for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']) key('keyup', code);
        window.clearInterval(timer);
        return;
      }
      const step = plan[i];
      if (!pressed) {
        for (const code of step.down) key('keydown', code);
        pressed = true;
      }
      if (step.done(session.getGame().getMarker().getPosition())) {
        for (const code of step.up) key('keyup', code);
        pressed = false;
        i++;
      }
    }, 16);
  });
  await advanceUntil(page, async () => (await status(page)) === 'stageclear', 12_000, 500);
}

// From STAGE CLEAR on to the next stage's play: a confirm completes the
// count, the next moves on.
async function nextStage(page: Page): Promise<void> {
  const stage = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStage());
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    if ((await status(page)) === 'playing') break;
  }
  expect(await status(page)).toBe('playing');
  expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStage())).toBe(stage + 1);
}

const remainingSec = (page: Page) =>
  page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getRemainingTicks() / 60);
// The intensity for the time left (BGM_INTENSITY_FROM_SEC: 135, 90, 30).
const intensityFor = (left: number): number => [135, 90, 30].filter((from) => left <= from).length;

async function timeUpToModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = (window as unknown as { __game__: GameHandle }).__game__.session;
    s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
  });
  await advanceUntil(page, async () => (await status(page)) === 'gameover', 1_000, FRAME_MS);
  await advanceUntil(page, () => page.locator('#gameover-modal').isVisible(), 500, FRAME_MS);
}

async function exportJson(page: Page): Promise<Record<string, unknown>> {
  await page.getByRole('button', { name: 'EXPORT', exact: true }).click();
  return JSON.parse(await page.locator('#debug-export-output').inputValue()) as Record<string, unknown>;
}

async function setSlider(page: Page, id: string, value: number): Promise<void> {
  await page.evaluate(
    ([sliderId, v]) => {
      const input = document.getElementById(sliderId as string) as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [id, value] as const
  );
}

const SOUND_TESTS: Array<[string, string]> = [
  ['claim-small', 'claim-small'],
  ['claim-mid', 'claim-mid'],
  ['claim-large', 'claim-large'],
  ['split', 'split'],
  ['miss', 'miss'],
  ['stage-clear', 'stage-clear'],
  ['gameover-life', 'gameover-life'],
  ['gameover-time', 'gameover-time'],
  ['count', 'count'],
  ['new-record', 'new-record'],
  ['alarm', 'alarm'],
  ['beep', 'beep'],
  ['beep-high', 'beep-high'],
  ['igniter-spawn', 'igniter-spawn'],
  ['igniter-approach', 'igniter-approach'],
  ['ember-spawn', 'ember-spawn'],
  ['blaze-spawn', 'blaze-spawn'],
  ['ember-line', 'ember-line'],
  ['ember-out', 'ember-out'],
  ['draw', 'draw'],
];

test.describe('the debug panel SOUND section', () => {
  test('its sliders, SOUND TEST and the BGM switch; each test plays its own sound once; nothing taints or starts a run', async ({ page }) => {
    await failRankingCheck(page);
    await soundOn(page);
    await pinNormalSeed(page, 1);
    await openDebug(page);
    const section = page.locator('#debug-sound-section');
    await expect(section.locator('input[type="range"]')).toHaveCount(7);
    for (const id of ['master', 'split', 'impact', 'warning', 'enemy', 'draw', 'bgm']) {
      await expect(page.locator(`#debug-sound-${id}`)).toBeAttached();
    }
    await expect(page.locator('#debug-bgm-enabled')).toBeChecked();
    // The music's level: a factor on the three tunes' gains, 1 to start with, 0 to 3.
    await expect(page.locator('#debug-sound-bgm')).toHaveAttribute('min', '0');
    await expect(page.locator('#debug-sound-bgm')).toHaveAttribute('max', '3');
    await expect(page.locator('#debug-sound-bgm')).toHaveAttribute('step', '0.05');
    await expect(page.locator('#debug-sound-bgm')).toHaveValue('1');
    await expect(section).toContainText('BGM (not saved)');
    await expect(page.locator('#debug-bgm-track')).toHaveCount(0);
    // The panel sits after FX and before PLAY LOG.
    const order = await page.evaluate(() => {
      const ids = ['debug-fx-section', 'debug-sound-section', 'debug-play-log'];
      const els = ids.map((id) => document.getElementById(id)!);
      return els[0].compareDocumentPosition(els[1]) & Node.DOCUMENT_POSITION_FOLLOWING && els[1].compareDocumentPosition(els[2]) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();

    for (const [id] of SOUND_TESTS) await page.locator(`#debug-sound-test-${id}`).click();
    await page.clock.runFor(100);
    expect(await sfxLog(page)).toEqual(SOUND_TESTS.map(([, name]) => name));
    expect(await status(page)).toBe('title');
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.isRunTainted())).toBe(false);

    // The next run is a normal one: it saves its best and is kept in the play log.
    await start(page);
    await claimSmallBox(page);
    await loseAllLivesToIgniter(page);
    const final = await score(page);
    expect(final).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.isRunTainted())).toBe(false);
    await page.clock.runFor(200);
    expect(await page.evaluate(() => localStorage.getItem('qixxx.highScore'))).toBe(String(final));
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.getPlayLog().length)).toBe(1);
  });

  test('muted, SOUND TEST plays nothing and leaves the sound off', async ({ page }) => {
    await openDebug(page);
    await page.locator('#debug-sound-test-miss').click();
    await page.locator('#debug-sound-test-new-record').click();
    expect(await sfxLog(page)).toEqual([]);
    await expect(page.locator('#mute-button')).toHaveText('SOUND: OFF');
  });

  test('the sliders change the levels; EXPORT gives them under their config names, the rest unchanged; RESET restores them', async ({ page }) => {
    await openDebug(page);
    const defaults = await exportJson(page);
    expect(defaults).toMatchObject({
      SFX_MASTER_GAIN: 0.25,
      SFX_LEVEL_SPLIT: 0.36,
      SFX_LEVEL_IMPACT: 0.28,
      SFX_LEVEL_WARNING: 0.2,
      SFX_LEVEL_ENEMY: 0.13,
      SFX_LEVEL_DRAW: 0.04,
      BGM_GAIN_TENSE: 0.2,
      BGM_GAIN_ACID: 0.18,
      BGM_GAIN_HUNT: 0.18,
    });
    expect(defaults).not.toHaveProperty('BGM_DEFAULT_TRACK');
    expect(defaults).not.toHaveProperty('BGM_GAIN');
    const moved: Record<string, [string, number]> = {
      SFX_MASTER_GAIN: ['debug-sound-master', 0.4],
      SFX_LEVEL_SPLIT: ['debug-sound-split', 0.5],
      SFX_LEVEL_IMPACT: ['debug-sound-impact', 0.1],
      SFX_LEVEL_WARNING: ['debug-sound-warning', 0.05],
      SFX_LEVEL_ENEMY: ['debug-sound-enemy', 0.02],
      SFX_LEVEL_DRAW: ['debug-sound-draw', 0.01],
    };
    for (const [id, value] of Object.values(moved)) await setSlider(page, id, value);
    // The BGM factor: x1.5 on every tune's gain.
    await setSlider(page, 'debug-sound-bgm', 1.5);
    const scaled = { BGM_GAIN_TENSE: 0.3, BGM_GAIN_ACID: 0.27, BGM_GAIN_HUNT: 0.27 };
    const exported = await exportJson(page);
    for (const [key, [, value]] of Object.entries(moved)) expect(exported[key], key).toBe(value);
    for (const [key, value] of Object.entries(scaled)) expect(exported[key], key).toBe(value);
    expect(exported).not.toHaveProperty('BGM_GAIN');
    for (const key of Object.keys(defaults)) {
      if (!(key in moved) && !(key in scaled)) expect(exported[key], key).toEqual(defaults[key]);
    }
    await page.getByRole('button', { name: 'RESET', exact: true }).click();
    expect(await exportJson(page)).toEqual(defaults);
    await expect(page.locator('#debug-sound-master')).toHaveValue('0.25');
    await expect(page.locator('#debug-sound-bgm')).toHaveValue('1');
  });

  test('without ?debug there is no SOUND section; muted (as on a first visit), no music source is made through a whole run', async ({ page }) => {
    await installFakeAudio(page);
    await open(page, '?seed=1');
    await expect(page.locator('#mute-button')).toHaveText('SOUND: OFF');
    await expect(page.locator('#debug-sound-section')).toHaveCount(0);
    await expect(page.locator('#debug-bgm-enabled')).toHaveCount(0);
    await start(page);
    await loseAllLivesToIgniter(page);
    await finishGameOverResult(page);
    expect(await bgmState(page)).toMatchObject({ playing: false, generation: 0, scheduled: 0, liveNodes: 0 });
    expect(await starts(page)).toEqual([]);
    expect(await noiseSources(page)).toBe(0);
  });
});

test.describe('the music', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeAudio(page);
  });

  test('without ?debug, sound on: silent on Title; it schedules through play, stops while paused, carries on after, stops on GAME OVER and starts over with the retry', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    // The SOUND button off and on again: user gestures, which start the audio, that start no run.
    await page.locator('#mute-button').click();
    await page.locator('#mute-button').click();
    await expect(page.locator('#mute-button')).toHaveText('SOUND: ON');
    await page.clock.runFor(2_000);
    expect(await status(page)).toBe('title');
    expect(await bgmState(page)).toMatchObject({ enabled: true, playing: false, generation: 0, scheduled: 0 });
    await start(page);
    await page.clock.runFor(1_000);
    const on = await bgmState(page);
    expect(on).toMatchObject({ enabled: true, playing: true, generation: 1, intensity: 0, bpm: 126 });
    expect(on.scheduled).toBeGreaterThan(0);

    await page.keyboard.press('KeyP');
    await page.clock.runFor(200);
    const paused = await bgmState(page);
    expect(paused.playing).toBe(false);
    await page.clock.runFor(2_000);
    expect((await bgmState(page)).scheduled).toBe(paused.scheduled);

    await page.keyboard.press('KeyP');
    await page.clock.runFor(1_500);
    const resumed = await bgmState(page);
    expect(resumed.playing).toBe(true);
    expect(resumed.generation).toBe(2);
    expect(resumed.scheduled).toBeGreaterThan(paused.scheduled);

    await loseAllLivesToIgniter(page);
    await advanceUntil(page, () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    const over = await bgmState(page);
    expect(over.playing).toBe(false);
    await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
    expect((await bgmState(page)).scheduled).toBe(over.scheduled);

    await page.keyboard.press('Enter');
    await page.clock.runFor(300);
    expect(await status(page)).toBe('playing');
    const retried = await bgmState(page);
    expect(retried).toMatchObject({ playing: true, generation: 3, intensity: 0 });
    // From the top: within the first bar.
    expect(retried.step).toBeLessThan(16);
    expect(retried.scheduled).toBeGreaterThan(over.scheduled);
  });

  test('hidden in play: stops at once with no frame drawn (its gain fading to 0 in 0.05s), and RESUME carries on in a new generation', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    await start(page);
    await page.clock.runFor(1_000);
    const on = await bgmState(page);
    expect(on.playing).toBe(true);

    // The clock is paused: no frame is drawn between hiding and reading.
    await setPageHidden(page, true);
    const hiddenAt = await audioNow(page);
    const hidden = await bgmState(page);
    expect(hidden.playing).toBe(false);
    expect(hidden.generation).toBe(on.generation);
    expect(hidden.scheduled).toBe(on.scheduled);
    expect(hidden.lastStop).not.toBeNull();
    expect(hidden.lastStop!.generation).toBe(on.generation);
    expect(hidden.lastStop!.at).toBeCloseTo(hiddenAt, 6);
    expect(hidden.lastStop!.end - hidden.lastStop!.at).toBeCloseTo(0.05, 6);
    expect(await page.evaluate(() => (window as unknown as { __game__: { isPaused: () => boolean } }).__game__.isPaused())).toBe(true);

    await page.clock.runFor(1_000);
    await setPageHidden(page, false);
    await page.clock.runFor(500);
    expect((await bgmState(page)).playing).toBe(false);
    await page.locator('#pause-resume').click();
    await page.clock.runFor(500);
    const resumed = await bgmState(page);
    expect(resumed.playing).toBe(true);
    expect(resumed.generation).toBe(on.generation + 1);
    expect(resumed.scheduled).toBeGreaterThan(hidden.scheduled);
  });

  test('each stage its tune: tense, on through STAGE CLEAR, acid from stage 2, hunt from 3, tense again from 4; the retry starts tense from the top', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    await start(page);
    await page.clock.runFor(500);
    expect(await bgmState(page)).toMatchObject({ playing: true, generation: 1, track: 'tense', bpm: 126, intensity: 0 });
    // A tiny goal and no Embers, so each stage clears with one small box;
    // 100 seconds left, so the intensity is 1 from here on (never back to 0).
    await page.evaluate(() => {
      const s = (window as unknown as { __game__: GameHandle }).__game__.session;
      s.applyDebugOverrides({ requiredOccupancy: 0.01, emberCount: 0 });
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 100 * 60);
    });
    await page.clock.runFor(200);
    expect(await bgmState(page)).toMatchObject({ playing: true, generation: 1, track: 'tense', intensity: 1 });

    const expected = [
      { stage: 2, track: 'acid', bpm: 130 },
      { stage: 3, track: 'hunt', bpm: 170 },
      { stage: 4, track: 'tense', bpm: 126 },
    ];
    for (const next of expected) {
      const playing = await bgmState(page);
      await clearStage(page);
      // STAGE CLEAR: the cleared stage's tune plays on, in the same generation.
      await page.clock.runFor(1_000);
      const clear = await bgmState(page);
      expect(clear, `STAGE CLEAR before stage ${next.stage}`).toMatchObject({ playing: true, generation: playing.generation, track: playing.track, bpm: playing.bpm });
      expect(clear.scheduled).toBeGreaterThan(playing.scheduled);

      await nextStage(page);
      const atStart = await audioNow(page);
      await page.clock.runFor(200);
      const s = await bgmState(page);
      expect(s, `stage ${next.stage}`).toMatchObject({ playing: true, generation: clear.generation + 1, track: next.track, bpm: next.bpm });
      expect(s.intensity).toBe(intensityFor(await remainingSec(page)));
      expect(s.intensity).toBeGreaterThanOrEqual(1);
      // The tune before stopped in 0.05s, on the stage's start; the new one is
      // within its first bar.
      expect(s.lastStop!.generation).toBe(clear.generation);
      expect(s.lastStop!.end - s.lastStop!.at).toBeCloseTo(0.05, 6);
      expect(s.lastStop!.at).toBeLessThanOrEqual(atStart + 1e-6);
      expect(s.lastStop!.at).toBeGreaterThan(atStart - 0.2);
      expect(s.step).toBeLessThan(16);
    }

    // GAME OVER, then the retry: tense from the top.
    await loseAllLivesToIgniter(page);
    await advanceUntil(page, () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    const over = await bgmState(page);
    expect(over).toMatchObject({ playing: false, track: 'tense' });
    await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
    await page.keyboard.press('Enter');
    await page.clock.runFor(300);
    expect(await status(page)).toBe('playing');
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStage())).toBe(1);
    const retried = await bgmState(page);
    expect(retried).toMatchObject({ playing: true, generation: over.generation + 1, track: 'tense', bpm: 126 });
    expect(retried.intensity).toBe(intensityFor(await remainingSec(page)));
    expect(retried.step).toBeLessThan(16);
  });

  test('on stage 2 (acid): a pause and RESUME, a hidden page and back, SOUND OFF and ON each carry on with acid', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    await start(page);
    await page.evaluate(() =>
      (window as unknown as { __game__: GameHandle }).__game__.session.applyDebugOverrides({ requiredOccupancy: 0.01, emberCount: 0 })
    );
    await clearStage(page);
    await nextStage(page);
    await page.clock.runFor(1_500);
    const on = await bgmState(page);
    expect(on).toMatchObject({ playing: true, track: 'acid', bpm: 130 });
    expect(on.step).toBeGreaterThanOrEqual(8);

    // A pause and RESUME: a new generation, acid from the next bar.
    await page.keyboard.press('KeyP');
    await page.clock.runFor(200);
    expect(await bgmState(page)).toMatchObject({ playing: false, track: 'acid' });
    await page.keyboard.press('KeyP');
    await page.clock.runFor(500);
    const resumed = await bgmState(page);
    expect(resumed).toMatchObject({ playing: true, generation: on.generation + 1, track: 'acid', bpm: 130 });
    expect(resumed.step).toBeGreaterThanOrEqual(16);

    // Hidden (which pauses the run) and back, then RESUME.
    await setPageHidden(page, true);
    expect(await bgmState(page)).toMatchObject({ playing: false, track: 'acid' });
    await page.clock.runFor(1_000);
    await setPageHidden(page, false);
    await page.clock.runFor(200);
    await page.locator('#pause-resume').click();
    await page.clock.runFor(500);
    const back = await bgmState(page);
    expect(back).toMatchObject({ playing: true, generation: resumed.generation + 1, track: 'acid', bpm: 130 });
    expect(back.step).toBeGreaterThan(resumed.step);

    // SOUND OFF and ON.
    const button = page.locator('#mute-button');
    await button.click();
    await expect(button).toHaveText('SOUND: OFF');
    expect(await bgmState(page)).toMatchObject({ playing: false, track: 'acid' });
    await page.clock.runFor(500);
    await button.click();
    await expect(button).toHaveText('SOUND: ON');
    await page.clock.runFor(500);
    expect(await bgmState(page)).toMatchObject({ playing: true, generation: back.generation + 1, track: 'acid', bpm: 130 });
    expect(await status(page)).toBe('playing');
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStage())).toBe(2);
  });

  test('muted, nothing is scheduled', async ({ page }) => {
    await openDebug(page, '&seed=1');
    await page.locator('#debug-bgm-enabled').check();
    await start(page);
    await page.clock.runFor(2_000);
    expect(await bgmState(page)).toMatchObject({ enabled: true, playing: false, scheduled: 0 });
    expect(await starts(page)).toEqual([]);
  });

  test('hidden on STAGE CLEAR for 5s: nothing for the hidden time, and back, only notes from now within the lookahead', async ({ page }) => {
    await soundOn(page);
    await openDebug(page, '&seed=1');
    await page.locator('#debug-bgm-enabled').check();
    await start(page);
    await page.evaluate(() =>
      (window as unknown as { __game__: GameHandle }).__game__.session.applyDebugOverrides({ requiredOccupancy: 0.01 })
    );
    await claimSmallBox(page);
    await advanceUntil(page, async () => (await status(page)) === 'stageclear', 2_000, FRAME_MS);
    await page.clock.runFor(500);
    const on = await bgmState(page);
    expect(on.playing).toBe(true);

    await setPageHidden(page, true);
    const hiddenAt = await audioNow(page);
    // Not a pause, but the generation stops at once all the same, with no frame drawn.
    const hidden = await bgmState(page);
    expect(hidden.playing).toBe(false);
    expect(hidden.lastStop!.generation).toBe(on.generation);
    expect(hidden.lastStop!.at).toBeCloseTo(hiddenAt, 6);
    expect(hidden.lastStop!.end - hidden.lastStop!.at).toBeCloseTo(0.05, 6);
    await page.clock.runFor(5_000);
    expect(await status(page)).toBe('stageclear');
    const backAt = await audioNow(page);
    expect(backAt - hiddenAt).toBeCloseTo(5, 1);
    const before = (await starts(page)).length;
    await setPageHidden(page, false);
    // The first scheduling with a note once back.
    await advanceUntil(page, async () => ((await bgmState(page)).lastBatch?.now ?? 0) >= backAt, 2_000, FRAME_MS);
    const batch = (await bgmState(page)).lastBatch!;
    expect(batch.min).toBeGreaterThanOrEqual(batch.now - 1e-6);
    expect(batch.max).toBeLessThanOrEqual(batch.now + LOOKAHEAD + STEP + 1e-6);
    const all = await starts(page);
    for (const t of all.slice(before)) expect(t).toBeGreaterThanOrEqual(backAt - 1e-6);
    // Nothing for the time the page was hidden.
    expect(all.filter((t) => t > hiddenAt + LOOKAHEAD + STEP && t < backAt)).toEqual([]);
    expect(await bgmState(page)).toMatchObject({ playing: true, generation: on.generation + 1 });
  });

  // 150 seconds of play: drawn every 200ms of game time (12 ticks a frame,
  // within the game's own 0.25s frame cap) on a small window, so it runs
  // well inside the test's time.
  test.describe('on a small window, drawn every 200ms', () => {
    test.use({ viewport: { width: 320, height: 240 } });

    test('without ?debug, under 30 seconds left: intensity 3 at the rush tempo', async ({ page }) => {
      await soundOn(page);
      await page.clock.install({ time: CLOCK_START });
      await page.addInitScript(() => {
        window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 200);
      });
      await page.goto(`${APP_URL}?seed=1`);
      await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
      await page.clock.runFor(400);
      await page.keyboard.press('Space');
      await page.clock.runFor(400);
      expect(await status(page)).toBe('playing');
      // No Embers (the marker waits on the border); the time limit is untouched.
      for (let i = 0; i < 40; i++) {
        await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.applyDebugOverrides({ emberCount: 0 }));
        const left = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getRemainingTicks() / 60);
        if (left < 29) break;
        await page.clock.runFor(Math.min(5_000, (left - 28.5) * 1000));
      }
      expect(await status(page)).toBe('playing');
      const s = await bgmState(page);
      expect(s).toMatchObject({ playing: true, intensity: 3, bpm: 140 });
    });
  });

  test('without ?debug, SOUND: ON: playing from the run start at 126 BPM and intensity 0, notes scheduled; under 30 seconds left, 140 BPM and intensity 3', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    await expect(page.locator('#mute-button')).toHaveText('SOUND: ON');
    await start(page);
    await page.clock.runFor(500);
    const first = await bgmState(page);
    expect(first).toMatchObject({ enabled: true, playing: true, generation: 1, track: 'tense', intensity: 0, bpm: 126 });
    expect(first.scheduled).toBeGreaterThan(0);
    await page.clock.runFor(500);
    const later = await bgmState(page);
    expect(later.scheduled).toBeGreaterThan(first.scheduled);
    expect(later.liveNodes).toBeGreaterThan(0);
    // The notes go on the audio clock, from now to within the lookahead.
    expect(later.lastBatch!.max).toBeLessThanOrEqual(later.lastBatch!.now + LOOKAHEAD + STEP + 1e-6);

    await page.evaluate(() => {
      const s = (window as unknown as { __game__: GameHandle }).__game__.session;
      s.applyDebugOverrides({ emberCount: 0 });
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 25 * 60);
    });
    await page.clock.runFor(300);
    expect(await status(page)).toBe('playing');
    expect(await bgmState(page)).toMatchObject({ playing: true, generation: 1, intensity: 3, bpm: 140 });
  });

  test('without ?debug, SOUND ON -> OFF -> ON in play: plays, stops that generation at once (0.05s), then a new generation at the pace for the time left then', async ({ page }) => {
    await open(page, '?seed=1');
    const button = page.locator('#mute-button');
    await expect(button).toHaveText('SOUND: OFF');
    await start(page);
    await page.clock.runFor(500);
    expect(await bgmState(page)).toMatchObject({ playing: false, generation: 0, scheduled: 0 });

    await button.click();
    await expect(button).toHaveText('SOUND: ON');
    await page.clock.runFor(500);
    const on = await bgmState(page);
    expect(on).toMatchObject({ playing: true, generation: 1, intensity: 0, bpm: 126 });
    expect(on.scheduled).toBeGreaterThan(0);

    // Off: stopped from the click itself, before any frame (the clock is paused).
    await button.click();
    const at = await audioNow(page);
    const off = await bgmState(page);
    expect(off.playing).toBe(false);
    expect(off.lastStop!.generation).toBe(1);
    expect(off.lastStop!.at).toBeCloseTo(at, 6);
    expect(off.lastStop!.end - off.lastStop!.at).toBeCloseTo(0.05, 6);
    await page.clock.runFor(1_000);
    expect((await bgmState(page)).scheduled).toBe(off.scheduled);

    // Under 30 seconds left by the next ON: it starts at that pace.
    await page.evaluate(() => {
      const s = (window as unknown as { __game__: GameHandle }).__game__.session;
      s.applyDebugOverrides({ emberCount: 0 });
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 25 * 60);
    });
    await button.click();
    await expect(button).toHaveText('SOUND: ON');
    await page.clock.runFor(300);
    expect(await status(page)).toBe('playing');
    const again = await bgmState(page);
    expect(again).toMatchObject({ playing: true, generation: 2, intensity: 3, bpm: 140 });
    expect(again.scheduled).toBeGreaterThan(off.scheduled);
  });

  test('the debug panel BGM switch: on at first; off stops the music at once, on plays it again in a new generation', async ({ page }) => {
    await soundOn(page);
    await openDebug(page, '&seed=1');
    const toggle = page.locator('#debug-bgm-enabled');
    await expect(toggle).toBeChecked();
    await start(page);
    await page.clock.runFor(500);
    expect(await bgmState(page)).toMatchObject({ enabled: true, playing: true, generation: 1 });

    await toggle.uncheck();
    const off = await bgmState(page);
    expect(off).toMatchObject({ enabled: false, playing: false });
    expect(off.lastStop!.generation).toBe(1);
    await page.clock.runFor(1_000);
    expect((await bgmState(page)).scheduled).toBe(off.scheduled);

    await toggle.check();
    await page.clock.runFor(500);
    const on = await bgmState(page);
    expect(on).toMatchObject({ enabled: true, playing: true, generation: 2 });
    expect(on.scheduled).toBeGreaterThan(off.scheduled);
    expect(await status(page)).toBe('playing');
  });

  test('the music changes nothing in the run: the same seed and script end the same, play log included, muted or with SOUND: ON', async ({ browser }) => {
    const play = async (withSound: boolean) => {
      // A small window: a whole run is drawn quickly.
      const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
      const page = await context.newPage();
      await installFakeAudio(page);
      await failRankingCheck(page);
      await pinNormalSeed(page, 1);
      if (withSound) await soundOn(page);
      // Paused before the page loads, so both runs tick in the same phase.
      await page.clock.install({ time: CLOCK_START });
      await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
      await page.goto(APP_URL);
      await page.clock.runFor(100);
      await start(page);
      await claimSmallBox(page);
      // Then stand still until the run ends, drawn every 200ms of game time
      // (12 ticks a frame, within the game's own frame cap) so the rest of
      // the run takes few frames. Keys pressed by the state read back (as
      // loseAllLivesToIgniter does) could land on another tick from one run
      // to the next; this script presses none.
      await page.evaluate(() => {
        window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 200);
      });
      for (let i = 0; i < 20 && (await status(page)) !== 'gameover'; i++) await page.clock.runFor(20_000);
      await finishGameOverResult(page);
      const result = await page.evaluate(() => {
        const s = (window as unknown as { __game__: GameHandle }).__game__.session;
        return { status: s.getStatus(), score: s.getScore(), stage: s.getStage(), lives: s.getLives(), ticks: s.getTotalTicks() };
      });
      const log = (await playLogRuns(page)).map((run) => ({ ...(run as Record<string, unknown>), endedAt: null }));
      const music = await bgmState(page);
      await context.close();
      return { result, log, music };
    };
    const on = await play(true);
    const off = await play(false);
    expect(on.music.scheduled).toBeGreaterThan(0);
    expect(off.music.scheduled).toBe(0);
    expect(on.result.status).toBe('gameover');
    expect(on.result.score).toBeGreaterThan(0);
    expect(on.result).toEqual(off.result);
    expect(on.log).toHaveLength(1);
    expect(on.log).toEqual(off.log);
  });
});
