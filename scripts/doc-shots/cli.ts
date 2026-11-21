// Takes the screenshots in docs/images/ (`npm run docs:shots`): all of them,
// or only the ones named on the command line
// (`npm run docs:shots -- hud wisp`; add `--log` to print the game state). Builds the game, serves it locally,
// drives each screen on a faked clock with made-up ranking data and writes
// the PNGs over the old ones. See SHOTS in ./shots.ts for each picture.
import { mkdirSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import {
  DEV_PORT,
  PREVIEW_PORT,
  run,
  startVite,
  assertPortFree,
  killServersNow,
  stopServers,
  type Server,
} from './server';
import { openPage, probe } from './page';
import { SHOTS, type Shot } from './shots';

const OUT_DIR = join(process.cwd(), 'docs', 'images');

function assertNoOffsite(shot: Shot, offsite: string[]): void {
  if (offsite.length > 0) throw new Error(`${shot.name}: requests left this machine: ${offsite.join(', ')}`);
}

async function shoot(browser: Browser, servers: Record<Shot['server'], Server | null>, shot: Shot): Promise<void> {
  const server = servers[shot.server];
  if (!server) throw new Error(`no ${shot.server} server for ${shot.name}`);
  const opened = await openPage(browser, server.url, shot.setup());
  const { context, page, offsite } = opened;
  try {
    await shot.prepare(page, opened);
    if (process.argv.includes('--log')) console.log(`  ${shot.name}: ${JSON.stringify(await probe(page))}`);
    const clip = shot.clip ? await shot.clip(page) : undefined;
    // Taken into memory and written only once no request has tried to leave
    // this machine (up to and through the screenshot): such a run keeps the
    // old picture.
    assertNoOffsite(shot, offsite);
    const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide', scale: 'device' });
    assertNoOffsite(shot, offsite);
    writeFileSync(join(OUT_DIR, `${shot.name}.png`), png);
    console.log(`shot ${shot.name}`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  // `--log` prints the game state along the way (see shots.ts).
  const names = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) throw new Error(`unknown shot(s): ${unknown.join(', ')}`);
  const shots = names.length > 0 ? SHOTS.filter((shot) => names.includes(shot.name)) : SHOTS;
  mkdirSync(OUT_DIR, { recursive: true });

  const needPreview = shots.some((shot) => shot.server === 'preview');
  const needDev = shots.some((shot) => shot.server === 'dev');
  // Fail on a taken port before the build, not after.
  if (needPreview) await assertPortFree(PREVIEW_PORT);
  if (needDev) await assertPortFree(DEV_PORT);
  if (needPreview) await run('npm', ['run', 'build']);

  const servers: Record<Shot['server'], Server | null> = { preview: null, dev: null };
  let browser: Browser | null = null;
  // Once, shared by the end of the run and a signal. The servers are stopped
  // through server.ts, which keeps each one from the moment it is spawned,
  // so a signal while one is still starting up stops it too.
  let stopping: Promise<void> | null = null;
  const stopAll = (): Promise<void> =>
    (stopping ??= (async () => {
      try {
        await browser?.close();
      } finally {
        await stopServers();
      }
    })());
  // The servers run in their own process groups, out of reach of the
  // terminal's Ctrl-C. A first signal stops them and waits; a second one
  // (Ctrl-C again while stopping) kills them at once; and whatever way the
  // process exits, a server still running is killed on the way out.
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = 128 + constants.signals[signal];
    if (signalled) {
      killServersNow();
      process.exit(code);
    }
    signalled = true;
    void stopAll().finally(() => process.exit(code));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', killServersNow);
  try {
    if (needPreview) servers.preview = await startVite('preview', PREVIEW_PORT);
    if (needDev) servers.dev = await startVite('dev', DEV_PORT);
    browser = await chromium.launch();
    for (const shot of shots) await shoot(browser, servers, shot);
  } finally {
    await stopAll();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
