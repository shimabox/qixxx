// Starts and stops the local servers the screenshots are taken from: the
// production build under `vite preview`, and Vite's dev server for the
// dev-only debug panel (`?debug`), which the production build leaves out.
// Each listens on 127.0.0.1 on a fixed port that stays clear of the E2E
// suite's (4173, 8790) and of `npm run dev`'s default (5173).
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

export const PREVIEW_PORT = 4290;
export const DEV_PORT = 4291;
export const HOST = '127.0.0.1';

/** Fails with a readable message when something already listens on `port`. */
export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(new Error(`port ${port} is already in use: stop whatever listens there and run docs:shots again`))
    );
    probe.listen(port, HOST, () => probe.close(() => resolve()));
  });
}

/**
 * Runs `command args` to the end, its output shown; rejects on a non-zero
 * exit. NODE_ENV is set to production: this script runs under vite-node,
 * which sets it to development, and a build that inherited that would be a
 * development build (with the dev-only debug panel), not the one players get.
 */
export async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))));
  });
}

export interface Server {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Every server process started, kept from the moment it is spawned (before
 * it answers), so stopServers() and killServersNow() reach a server that is
 * still starting up when the script is stopped. A server runs in its own
 * process group and does not get the terminal's Ctrl-C: it is only stopped
 * from here.
 */
const started = new Set<ChildProcess>();

/** Stops every server started (one still starting up too) and waits for each to exit. */
export async function stopServers(): Promise<void> {
  await Promise.all([...started].map((child) => stopProcess(child)));
}

/**
 * Kills every server started that is still running, at once: for when the
 * script cannot wait (a second Ctrl-C while stopping, or the process exiting).
 */
export function killServersNow(): void {
  for (const child of started) {
    if (running(child)) signalGroup(child, 'SIGKILL');
  }
}

/**
 * Starts `vite <mode>` on `port` in its own process group (so stopping it
 * also stops the processes npx starts under it) and waits until it answers.
 */
export async function startVite(mode: 'preview' | 'dev', port: number): Promise<Server> {
  await assertPortFree(port);
  const args = mode === 'preview' ? ['vite', 'preview'] : ['vite'];
  args.push('--host', HOST, '--port', String(port), '--strictPort');
  const child = spawn('npx', args, { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  started.add(child);
  const url = `http://${HOST}:${port}/`;
  const server: Server = { url, stop: () => stopProcess(child) };
  try {
    await waitUntilServing(url, child);
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

async function waitUntilServing(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server for ${url} exited (${child.exitCode}) before answering`);
    if (await answers(url)) return;
    await sleep(200);
  }
  throw new Error(`the server for ${url} did not answer within 60s`);
}

function answers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once('error', () => resolve(false));
  });
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && child.pid !== undefined;
}

/** Sends `signal` to the child's process group; false when there is none left. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (!running(child)) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (!signalGroup(child, 'SIGTERM')) return;
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}
