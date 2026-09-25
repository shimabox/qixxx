// HISTORICAL HARNESS for the Paid synchronous-verification version of the
// score-ranking verification path. It cannot run against the current
// asynchronous API because verification no longer happens in POST /api/scores.
// The command used for the historical measurement was:
//
//   npx vite-node docs/measurements/measure-verify-cpu.ts
//
// Writes, into this same directory and all from ONE process:
//   verify-cpu-<timestamp>.progress.txt   append-only progress log
//   verify-cpu-<timestamp>.json           per-series raw samples + statistics
//   verify-cpu-<timestamp>-summary.json   the p99s and the gate verdict
//
// ---------------------------------------------------------------------------
// WHAT THIS MEASURES, AND WHY IT DIFFERS FROM THE EARLIER ATTEMPTS
// ---------------------------------------------------------------------------
// It times the *verification core* — the resimulation that dominates
// POST /api/scores' cost — in-process, single-threaded, strictly serially.
//
// It deliberately does NOT go over HTTP, for two reasons:
//   1. The endpoint the earlier local harness measured (`/api/_cpu-spike`)
//      was a benchmark-only route that has since been removed from the
//      artifact on purpose (no 10800-tick resimulation reachable from the
//      public internet). Anything that depended on it is not reproducible.
//   2. Local `wrangler pages dev` wall-clock includes queueing, Miniflare
//      overhead, local SQLite access and GC. That noise is exactly what made
//      the earlier local numbers unreliable, and none of it is the CPU time
//      Cloudflare meters.
// A real POST cannot stand in either: the D1 rate limiter allows 30 requests
// per IP per hour, and the max-enemy-load fixtures can only be built through the
// bench gameFactory, which production intentionally cannot reach.
//
// So: this is a clean, reproducible measurement of the dominant cost, not an
// end-to-end request measurement. It is a LOWER BOUND on per-request CPU
// (it excludes hashing, D1 and response generation, all small by comparison).
// Real CPU time still has to be confirmed on a Paid preview deployment.
import { Field } from '../../src/core/field';
import { Game, GameOptions } from '../../src/core/game';
import { Wisp, Rng } from '../../src/core/enemy';
import { Ember, Heading } from '../../src/core/patrol';
import { getStageConfig } from '../../src/core/stage';
import { mulberry32 } from '../../src/core/rng';
import { GameSession, SessionOptions } from '../../src/core/session';
import { InputSample, encodeRle } from '../../src/core/rle';
import { simulateReplayFromRle } from '../../src/core/replayEngine';
import { verifyReplay } from '../../functions/_lib/ranking/verifyReplay';
import { GRID_WIDTH, GRID_HEIGHT, MAX_VERIFIED_CLAIMS } from '../../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type Axis = -1 | 0 | 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const PROGRESS = path.join(HERE, `verify-cpu-${STAMP}.progress.txt`);
const RESULTS = path.join(HERE, `verify-cpu-${STAMP}.json`);
const SUMMARY = path.join(HERE, `verify-cpu-${STAMP}-summary.json`);

const WARMUP = 10;
const MEASURED = 100;
const BENCH_STAGE = 10;
const RNG_SEED = 424242;

// Guards against the defect that invalidated the previous measurement: three
// copies of the script ran at once, interleaving their output into one shared
// progress file and competing for CPU. A pid-stamped lock makes a second
// concurrent run refuse to start instead of silently corrupting the data.
const LOCK = path.join(HERE, '.measure-verify-cpu.lock');

function progress(msg: string): void {
  const line = `[${new Date().toISOString()}] [pid ${process.pid}] ${msg}`;
  console.log(line);
  fs.appendFileSync(PROGRESS, line + '\n');
}

function nearestRankP99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.ceil(0.99 * sorted.length)) - 1];
}

/**
 * Bench-only state injection (never reachable from the production bundle —
 * `gameFactory` is an optional pass-through on SessionOptions that no
 * production call site sets). Builds a stage-10-config board with the enemy
 * counts at their ceiling.
 *
 * `neutralized` keeps the enemy *objects* present (so claim processing still
 * pays to enumerate them and re-test despawns) while zeroing their movement,
 * which is what fixture B needs to isolate claim cost.
 */
function makeBenchGameFactory(neutralized: boolean): NonNullable<SessionOptions['gameFactory']> {
  return (_stage, carry) => {
    const config = getStageConfig(BENCH_STAGE);
    const field = new Field(GRID_WIDTH, GRID_HEIGHT);
    const markerStart = { x: Math.floor(field.getWidth() / 2), y: 0 };
    const rng: Rng = mulberry32(RNG_SEED);

    const cx = Math.floor(field.getWidth() / 2);
    const cy = Math.floor(field.getHeight() / 2);
    const wisps: Wisp[] = [];
    for (let i = 0; i < config.wispCount; i++) {
      const x = cx + Math.round((i - (config.wispCount - 1) / 2) * 3);
      wisps.push(new Wisp({ x, y: cy }, rng, undefined, neutralized ? 0 : 1));
    }

    const embers: Ember[] = [];
    for (let i = 0; i < config.maxConcurrentEmbers; i++) {
      const onRight = i % 2 === 1;
      const start = { x: onRight ? field.getWidth() - 1 : 0, y: 0 };
      const heading: Heading = onRight ? { dx: -1, dy: 0 } : { dx: 1, dy: 0 };
      embers.push(new Ember(start, heading, rng, neutralized ? 1_000_000 : config.emberMoveTicks, 0, false));
    }

    const options: GameOptions = {
      wisps,
      embers,
      emberSpawnIntervalTicks: config.emberSpawnIntervalTicks,
      emberMoveTicks: config.emberMoveTicks,
      emberBranchChaseProbability: neutralized ? 0 : config.emberBranchChaseProbability,
      maxConcurrentEmbers: config.maxConcurrentEmbers,
      requiredOccupancy: config.requiredOccupancy,
      score: carry.score,
      lives: carry.lives,
      multiplier: carry.multiplier,
    };
    return new Game(field, markerStart, undefined, rng, options);
  };
}

/** Fixture A: enemies at their ceiling and actually moving; the marker idles on the border for the full 10800 ticks. */
function buildFixtureA(maxTicks: number): Uint8Array {
  const session = new GameSession({ gameFactory: makeBenchGameFactory(false) });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  while (session.getTotalTicks() < maxTicks && session.getStatus() === 'playing') {
    const s: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...s, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    samples.push(s);
  }
  return encodeRle(samples);
}

/**
 * Fixture B: enemy objects at their ceiling but neutralized, a heavy
 * (barely-shrinking) unclaimed region, and exactly `targetClaims` successful
 * claims produced through real Game.update() calls — never by writing to the
 * field directly. Padded out to `maxTicks` so the run is a genuine
 * full-length one.
 */
function buildFixtureB(targetClaims: number, maxTicks: number): { rle: Uint8Array; claims: number } {
  const session = new GameSession({ gameFactory: makeBenchGameFactory(true) });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const field = session.getGame().getField();
  const width = field.getWidth();
  const height = field.getHeight();
  const samples: InputSample[] = [];
  let claims = 0;

  const push = (dx: Axis, dy: Axis, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    for (const ev of session.drainEvents()) if (ev === 'area-claimed') claims++;
    session.drainDespawnedEmberPositions();
  };

  const notchDepth = 4;
  const pitch = 3;
  const bandLo = 2;
  const slotsPerRow = Math.floor((width - 3 - bandLo) / pitch);
  const rows = [0, height - 1] as const;
  let slot = 0;

  while (claims < targetClaims && session.getStatus() === 'playing' && samples.length < maxTicks - 200) {
    if (slot >= slotsPerRow * rows.length) break;
    const row = rows[Math.floor(slot / slotsPerRow)];
    const col = bandLo + (slot % slotsPerRow) * pitch;
    const dive: Axis = row === 0 ? 1 : -1;
    slot++;

    let pos = session.getGame().getMarker().getPosition();
    if (pos.y !== row) {
      const sideX = pos.x < width / 2 ? 0 : width - 1;
      while (pos.x !== sideX && session.getStatus() === 'playing') {
        push(pos.x < sideX ? 1 : -1, 0, false);
        pos = session.getGame().getMarker().getPosition();
      }
      while (pos.y !== row && session.getStatus() === 'playing') {
        push(0, pos.y < row ? 1 : -1, false);
        pos = session.getGame().getMarker().getPosition();
      }
    }
    while (pos.x !== col && session.getStatus() === 'playing') {
      push(pos.x < col ? 1 : -1, 0, false);
      pos = session.getGame().getMarker().getPosition();
    }
    for (let i = 0; i < notchDepth; i++) push(0, dive, true);
    push(1, 0, true);
    for (let i = 0; i < notchDepth + 1; i++) {
      if (session.getGame().getMarker().getPosition().y === row) break;
      push(0, (-dive) as Axis, true);
    }
  }
  while (session.getTotalTicks() < maxTicks && session.getStatus() === 'playing') push(0, 0, false);

  return { rle: encodeRle(samples), claims };
}

/** Fixture R: a realistic production-path run — no gameFactory at all, so this one goes through the true verifyReplay(). */
function buildFixtureR(seed: number): Uint8Array {
  const session = new GameSession({ seed });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard++ < 20000) {
    const s: InputSample = { dx: 0, dy: 1, drawHeld: true, slow: false };
    session.update({ ...s, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    samples.push(s);
  }
  return encodeRle(samples);
}

/**
 * One measured call. Mirrors verifyReplay()'s own contract exactly — same
 * MAX_VERIFIED_CLAIMS onTick early-stop — but can inject the bench factory,
 * which verifyReplay() (correctly) offers no way to do. The realistic series
 * calls the real verifyReplay() instead, as an anchor that the two agree.
 */
function runOnce(seed: number, rle: Uint8Array, gameFactory?: SessionOptions['gameFactory']): { ms: number; note: string } {
  const t0 = performance.now();
  if (!gameFactory) {
    const result = verifyReplay(seed, rle);
    return { ms: performance.now() - t0, note: result.ok ? `ok score=${result.score}` : `rejected:${result.reason}` };
  }
  const result = simulateReplayFromRle(seed, rle, {
    gameFactory,
    onTick: ({ totalClaimsSoFar }) => totalClaimsSoFar > MAX_VERIFIED_CLAIMS,
  });
  const rejected = !result.reachedGameOver && result.totalClaims > MAX_VERIFIED_CLAIMS;
  return {
    ms: performance.now() - t0,
    note: rejected
      ? `rejected:max-verified-claims-exceeded ticks=${result.durationTicks}`
      : `ok ticks=${result.durationTicks} claims=${result.totalClaims}`,
  };
}

interface SeriesSpec {
  name: string;
  description: string;
  seed: number;
  rle: Uint8Array;
  gameFactory?: SessionOptions['gameFactory'];
}

function measureSeries(spec: SeriesSpec) {
  progress(`[${spec.name}] warmup (${WARMUP} calls, serial)...`);
  for (let i = 0; i < WARMUP; i++) runOnce(spec.seed, spec.rle, spec.gameFactory);

  progress(`[${spec.name}] measuring (${MEASURED} calls, serial)...`);
  const samples: number[] = [];
  const notes = new Set<string>();
  for (let i = 0; i < MEASURED; i++) {
    const { ms, note } = runOnce(spec.seed, spec.rle, spec.gameFactory);
    samples.push(ms);
    notes.add(note);
    if ((i + 1) % 20 === 0) progress(`[${spec.name}] ${i + 1}/${MEASURED} done (last=${ms.toFixed(1)}ms, ${note})`);
  }

  const p99 = nearestRankP99(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  progress(
    `[${spec.name}] p99=${p99.toFixed(2)}ms mean=${mean.toFixed(2)}ms min=${Math.min(...samples).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms outcomes=${[...notes].join('|')}`
  );
  return {
    series: spec.name,
    description: spec.description,
    measuredCount: MEASURED,
    warmupCount: WARMUP,
    p99Ms: Number(p99.toFixed(2)),
    meanMs: Number(mean.toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    outcomes: [...notes],
    sampleMs: samples.map((s) => Number(s.toFixed(3))),
  };
}

function main(): void {
  if (fs.existsSync(LOCK)) {
    console.error(`refusing to start: ${LOCK} exists (another run may be in progress). Remove it if that is stale.`);
    process.exit(2);
  }
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    progress(`START single-process serial measurement (node ${process.version})`);

    progress('building fixtures...');
    const maxTicks = 10800;
    const rleA = buildFixtureA(maxTicks);
    const b100 = buildFixtureB(MAX_VERIFIED_CLAIMS, maxTicks);
    const b101 = buildFixtureB(MAX_VERIFIED_CLAIMS + 1, maxTicks);
    const rleR = buildFixtureR(4242);
    progress(`fixtures built: A=${rleA.length}B Bsuccess=${b100.rle.length}B (claims=${b100.claims}) Brejected=${b101.rle.length}B (claims=${b101.claims}) Realistic=${rleR.length}B`);
    if (b100.claims !== MAX_VERIFIED_CLAIMS || b101.claims !== MAX_VERIFIED_CLAIMS + 1) {
      throw new Error(`fixture B claim counts wrong: ${b100.claims}/${b101.claims}`);
    }

    const results = [
      measureSeries({ name: 'A', description: 'Max enemy load (stage-10 counts, moving), 10800 ticks', seed: RNG_SEED, rle: rleA, gameFactory: makeBenchGameFactory(false) }),
      measureSeries({ name: 'Bsuccess', description: `Max claim load, ${MAX_VERIFIED_CLAIMS} claims, 10800 ticks`, seed: RNG_SEED, rle: b100.rle, gameFactory: makeBenchGameFactory(true) }),
      measureSeries({ name: 'Brejected', description: `${MAX_VERIFIED_CLAIMS + 1}th claim -> early rejection`, seed: RNG_SEED, rle: b101.rle, gameFactory: makeBenchGameFactory(true) }),
      measureSeries({ name: 'Realistic', description: 'Ordinary stage-1 run through the real verifyReplay() (no gameFactory)', seed: 4242, rle: rleR }),
    ];

    const byName = Object.fromEntries(results.map((r) => [r.series, r]));
    const combined = byName.A.p99Ms + Math.max(byName.Bsuccess.p99Ms, byName.Brejected.p99Ms);
    const summary = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      measures: 'verifyReplay-equivalent resimulation, in-process, single-threaded, serial',
      warmupCount: WARMUP,
      measuredCount: MEASURED,
      p99Ms: { A: byName.A.p99Ms, Bsuccess: byName.Bsuccess.p99Ms, Brejected: byName.Brejected.p99Ms, Realistic: byName.Realistic.p99Ms },
      combinedP99Ms: Number(combined.toFixed(2)),
      thresholdMs: 1000,
      verdict: combined <= 1000 ? 'PASS' : 'FAIL',
      suggestedCpuMsLimit: Math.ceil((combined * 2) / 1000) * 1000,
    };

    fs.writeFileSync(RESULTS, JSON.stringify({ summary, series: results }, null, 2));
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
    progress(`DONE combined p99 = ${byName.A.p99Ms} + max(${byName.Bsuccess.p99Ms}, ${byName.Brejected.p99Ms}) = ${combined.toFixed(2)}ms vs 1000ms -> ${summary.verdict}`);
    progress(`wrote ${path.basename(RESULTS)} and ${path.basename(SUMMARY)}`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

main();
