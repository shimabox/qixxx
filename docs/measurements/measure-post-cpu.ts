// LOCAL IN-PROCESS WALL-CLOCK BENCHMARK for POST /api/scores.
//
// Role (see docs/ranking-cpu-measurement.md's positioning section): this is a
// reproducible LOCAL BASELINE for comparing the CPU-dominant part of the
// implementation — regression detection and relative comparison. It does NOT
// decide `cpu_ms`, and it does NOT decide whether the Paid plan is viable.
// Free-tier non-viability was already settled by task 1's real Cloudflare
// measurement (widespread exceededCpu). Paid viability and the final
// `cpu_ms` are decided from real CPU time on a Paid preview deployment.
//
// Run from the repo root:
//
//   npx vite-node docs/measurements/measure-post-cpu.ts
//
// Writes, all from ONE process, into this directory:
//   post-cpu-<stamp>.progress.txt / .json / -summary.json
//
// ---------------------------------------------------------------------------
// WHAT THIS MEASURES
// ---------------------------------------------------------------------------
// The REAL production handler (functions/api/scores.ts's onRequestPost),
// driven in-process with a genuine Request: origin/content-type checks,
// streaming body read, seed validation, base64 decode, verifyReplay()'s full
// RLE-validating resimulation, the replay hash over Web Crypto, the D1 batch,
// and JSON response generation. That is the "RLE 検証展開からレスポンス生成
// まで、本番 POST と同じ経路" the measurement protocol asks for.
//
// Driven in-process rather than over HTTP on purpose:
//   - no benchmark ROUTE is added to the deployed artifact (the earlier spike
//     endpoint was removed for exactly that reason, and is not coming back);
//   - it excludes wrangler/Miniflare queueing and socket overhead, which is
//     not CPU time Cloudflare meters and which wrecked an earlier attempt;
//   - it is reproducible with no server, no ports and no account.
//
// D1 and KV are in-memory mocks. Their real cost is I/O, not CPU, and mocking
// them keeps the run deterministic; the SQL is still prepared and bound
// exactly as in production. So the number excludes database/KV I/O entirely —
// good for a stable local baseline, but another reason it is not the real
// per-request cost and must not be used to fix `cpu_ms`.
//
// The max-load fixtures need enemy counts and lives production can never
// produce, so they are injected via the bench hook — see
// functions/_lib/ranking/benchHooks.ts for why that hook cannot be armed by
// any remote caller (it requires a live JS function on `env`).
import { onRequestPost } from '../../functions/api/scores';
import { Field } from '../../src/core/field';
import { Game, GameOptions } from '../../src/core/game';
import { Wisp, Rng } from '../../src/core/enemy';
import { Ember, Heading } from '../../src/core/patrol';
import { getStageConfig } from '../../src/core/stage';
import { mulberry32 } from '../../src/core/rng';
import { GameSession, SessionOptions } from '../../src/core/session';
import { InputSample, encodeRle } from '../../src/core/rle';
import { GRID_WIDTH, GRID_HEIGHT, MAX_VERIFIED_CLAIMS, RULESET_VERSION, REPLAY_FORMAT_VERSION, TIME_LIMIT_TICKS } from '../../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type Axis = -1 | 0 | 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const PROGRESS = path.join(HERE, `post-cpu-${STAMP}.progress.txt`);
const RESULTS = path.join(HERE, `post-cpu-${STAMP}.json`);
const SUMMARY = path.join(HERE, `post-cpu-${STAMP}-summary.json`);
const LOCK = path.join(HERE, '.measure-post-cpu.lock');

const WARMUP = 10;
const MEASURED = 100;
const BENCH_STAGE = 10;
const RNG_SEED = 424242;
const SELF_ORIGIN = 'https://qixxx.example';
// Enough that no fixture can ever run out of lives before the time limit —
// fixture A's whole point is completing all 10800 ticks under maximum enemy
// pressure, and with ordinary lives the marker dies in a few hundred ticks.
const BENCH_LIVES = 1_000_000;

function progress(msg: string): void {
  const line = `[${new Date().toISOString()}] [pid ${process.pid}] ${msg}`;
  console.log(line);
  fs.appendFileSync(PROGRESS, line + '\n');
}

function nearestRankP99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.ceil(0.99 * sorted.length)) - 1];
}

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
      lives: BENCH_LIVES,
      multiplier: carry.multiplier,
    };
    return new Game(field, markerStart, undefined, rng, options);
  };
}

/** Fixture A: enemies at their ceiling and moving, marker surviving all 10800 ticks to a clean TIME UP. */
function buildFixtureA(): { rle: Uint8Array; ticks: number; reason: string | null } {
  const session = new GameSession({ gameFactory: makeBenchGameFactory(false) });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard++ < TIME_LIMIT_TICKS + 100) {
    const s: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...s, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    samples.push(s);
  }
  return { rle: encodeRle(samples), ticks: session.getTotalTicks(), reason: session.getGameOverReason() };
}

/** Fixture B: enemies present but neutralized, heavy topology, exactly `targetClaims` claims via real Game.update(). */
function buildFixtureB(targetClaims: number): { rle: Uint8Array; claims: number; ticks: number; reason: string | null } {
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

  while (claims < targetClaims && session.getStatus() === 'playing' && samples.length < TIME_LIMIT_TICKS - 200) {
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
  while (session.getStatus() !== 'gameover' && samples.length < TIME_LIMIT_TICKS) push(0, 0, false);

  return { rle: encodeRle(samples), claims, ticks: session.getTotalTicks(), reason: session.getGameOverReason() };
}

/** Fixture R: an ordinary stage-1 run, no bench hook at all — the true production path end to end. */
function buildFixtureR(seed: number): { rle: Uint8Array; ticks: number } {
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
  return { rle: encodeRle(samples), ticks: session.getTotalTicks() };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return Buffer.from(binary, 'binary').toString('base64');
}

/** In-memory D1/KV stubs: the handler's SQL is still prepared and bound, only the I/O is elided. */
function makeEnv(gameFactory?: NonNullable<SessionOptions['gameFactory']>) {
  const kv = new Map<string, string>();
  return {
    SHARES: {
      get: async (k: string) => kv.get(k) ?? null,
      // Rate limiting is bypassed by simply never recording a hit: the
      // harness is a single client issuing hundreds of requests, which the
      // production limiter (10/IP/hour) would otherwise reject.
      put: async () => undefined,
    },
    DB: {
      prepare: (_sql: string) => ({ bind: (...args: unknown[]) => ({ args }) }),
      batch: async (statements: { args: unknown[] }[]) => [
        {},
        {},
        { results: [{ id: statements[0].args[0] }] },
      ],
    },
    ...(gameFactory ? { BENCH_HOOKS: 'enabled', BENCH_GAME_FACTORY: gameFactory } : {}),
  };
}

async function postOnce(env: ReturnType<typeof makeEnv>, seed: number, rleBase64: string) {
  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.1' },
    body: JSON.stringify({ seed, rleBase64, name: 'BENCH', rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
  });
  type Ctx = Parameters<typeof onRequestPost>[0];
  const t0 = performance.now();
  const response = await onRequestPost({ request, env, params: {} } as unknown as Ctx);
  const body = (await response.json()) as Record<string, unknown>;
  const ms = performance.now() - t0;
  return { ms, status: response.status, body };
}

/**
 * What every single request in a series must produce. Checked per request,
 * not merely recorded: a series whose replay silently stops early (or starts
 * being rejected) would otherwise still yield a p99 and a verdict, which is
 * exactly how a fixture that died after 715 ticks once got published as a
 * 10800-tick result.
 */
interface SeriesExpectation {
  status: number;
  accepted: boolean;
  /** Exact match against the handler's own reported durationTicks, when the response carries one. */
  durationTicks?: number;
  /** Exact match against the handler's error string, for the rejection series. */
  error?: string;
}

interface SeriesSpec {
  name: string;
  description: string;
  seed: number;
  rleBase64: string;
  gameFactory?: NonNullable<SessionOptions['gameFactory']>;
  expect: SeriesExpectation;
}

/** Throws (aborting the whole measurement) unless the response matches the series' expectation exactly. */
function assertResponse(series: string, phase: string, index: number, expect: SeriesExpectation, actual: { status: number; body: Record<string, unknown> }): void {
  const problems: string[] = [];
  if (actual.status !== expect.status) problems.push(`status ${actual.status} != ${expect.status}`);
  if (actual.body.accepted !== expect.accepted) problems.push(`accepted ${String(actual.body.accepted)} != ${String(expect.accepted)}`);
  if (expect.durationTicks !== undefined && actual.body.durationTicks !== expect.durationTicks) {
    problems.push(`durationTicks ${String(actual.body.durationTicks)} != ${expect.durationTicks}`);
  }
  if (expect.error !== undefined && actual.body.error !== expect.error) {
    problems.push(`error ${JSON.stringify(actual.body.error)} != ${JSON.stringify(expect.error)}`);
  }
  if (problems.length > 0) {
    throw new Error(`[${series}] ${phase} request #${index + 1} did not meet the series expectation: ${problems.join('; ')} (body=${JSON.stringify(actual.body)})`);
  }
}

async function measureSeries(spec: SeriesSpec) {
  const env = makeEnv(spec.gameFactory);
  let assertionsChecked = 0;

  progress(`[${spec.name}] warmup (${WARMUP} requests, serial)...`);
  for (let i = 0; i < WARMUP; i++) {
    const r = await postOnce(env, spec.seed, spec.rleBase64);
    // Asserted during warmup too: a misconfigured series should abort before
    // it spends minutes producing numbers that will be thrown away.
    assertResponse(spec.name, 'warmup', i, spec.expect, r);
    assertionsChecked++;
  }

  progress(`[${spec.name}] measuring (${MEASURED} requests, serial)...`);
  const samples: number[] = [];
  const outcomes = new Set<string>();
  const tickValues = new Set<number>();
  for (let i = 0; i < MEASURED; i++) {
    const { ms, status, body } = await postOnce(env, spec.seed, spec.rleBase64);
    assertResponse(spec.name, 'measured', i, spec.expect, { status, body });
    assertionsChecked++;
    samples.push(ms);
    const ticks = typeof body.durationTicks === 'number' ? body.durationTicks : -1;
    tickValues.add(ticks);
    outcomes.add(`status=${status} accepted=${body.accepted} ticks=${ticks}${body.error ? ` error=${body.error}` : ''}`);
    if ((i + 1) % 20 === 0) progress(`[${spec.name}] ${i + 1}/${MEASURED} done (last=${ms.toFixed(1)}ms, status=${status}, ticks=${ticks})`);
  }
  progress(`[${spec.name}] all ${assertionsChecked} responses matched the series expectation ${JSON.stringify(spec.expect)}`);

  const p99 = nearestRankP99(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  progress(
    `[${spec.name}] p99=${p99.toFixed(2)}ms mean=${mean.toFixed(2)}ms min=${Math.min(...samples).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms outcomes=${[...outcomes].join('|')}`
  );
  return {
    series: spec.name,
    description: spec.description,
    warmupCount: WARMUP,
    measuredCount: MEASURED,
    expectation: spec.expect,
    assertionsChecked,
    p99Ms: Number(p99.toFixed(2)),
    meanMs: Number(mean.toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    outcomes: [...outcomes],
    durationTicksObserved: [...tickValues],
    sampleMs: samples.map((s) => Number(s.toFixed(3))),
  };
}

async function main(): Promise<void> {
  if (fs.existsSync(LOCK)) {
    console.error(`refusing to start: ${LOCK} exists (another run may be in progress). Remove it if stale.`);
    process.exit(2);
  }
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    progress(`START single-process serial full-path measurement (node ${process.version})`);
    progress('building fixtures...');

    const a = buildFixtureA();
    const b100 = buildFixtureB(MAX_VERIFIED_CLAIMS);
    const b101 = buildFixtureB(MAX_VERIFIED_CLAIMS + 1);
    const r = buildFixtureR(4242);
    progress(
      `fixtures: A ticks=${a.ticks} reason=${a.reason} | Bsuccess ticks=${b100.ticks} claims=${b100.claims} | Brejected claims=${b101.claims} | Realistic ticks=${r.ticks}`
    );

    // Acceptance criteria for the fixtures themselves — the check missed last
    // time, when fixture A silently died after 715 ticks and its p99 was
    // reported as "max enemy load, 10800 ticks".
    if (a.ticks !== TIME_LIMIT_TICKS || a.reason !== 'time') {
      throw new Error(`fixture A must complete ${TIME_LIMIT_TICKS} ticks and end on time-up, got ticks=${a.ticks} reason=${a.reason}`);
    }
    if (b100.ticks !== TIME_LIMIT_TICKS || b100.claims !== MAX_VERIFIED_CLAIMS) {
      throw new Error(`fixture B-success must complete ${TIME_LIMIT_TICKS} ticks with ${MAX_VERIFIED_CLAIMS} claims, got ticks=${b100.ticks} claims=${b100.claims}`);
    }
    if (b101.claims !== MAX_VERIFIED_CLAIMS + 1) {
      throw new Error(`fixture B-rejected must reach ${MAX_VERIFIED_CLAIMS + 1} claims, got ${b101.claims}`);
    }

    const results = [
      await measureSeries({
        name: 'A',
        description: `Max enemy load (stage-10 counts, moving), ${TIME_LIMIT_TICKS} ticks to TIME UP`,
        seed: RNG_SEED,
        rleBase64: bytesToBase64(a.rle),
        gameFactory: makeBenchGameFactory(false),
        expect: { status: 200, accepted: true, durationTicks: TIME_LIMIT_TICKS },
      }),
      await measureSeries({
        name: 'Bsuccess',
        description: `Max claim load, ${MAX_VERIFIED_CLAIMS} claims, ${TIME_LIMIT_TICKS} ticks`,
        seed: RNG_SEED,
        rleBase64: bytesToBase64(b100.rle),
        gameFactory: makeBenchGameFactory(true),
        expect: { status: 200, accepted: true, durationTicks: TIME_LIMIT_TICKS },
      }),
      await measureSeries({
        name: 'Brejected',
        description: `${MAX_VERIFIED_CLAIMS + 1}th claim -> early rejection (422)`,
        seed: RNG_SEED,
        rleBase64: bytesToBase64(b101.rle),
        gameFactory: makeBenchGameFactory(true),
        expect: { status: 422, accepted: false, error: 'max-verified-claims-exceeded' },
      }),
      await measureSeries({
        name: 'Realistic',
        description: 'Ordinary stage-1 run through the unmodified production path (no bench hook)',
        seed: 4242,
        rleBase64: bytesToBase64(r.rle),
        expect: { status: 200, accepted: true, durationTicks: r.ticks },
      }),
    ];

    const by = Object.fromEntries(results.map((x) => [x.series, x]));
    const combined = by.A.p99Ms + Math.max(by.Bsuccess.p99Ms, by.Brejected.p99Ms);
    const summary = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      measures: 'POST /api/scores onRequestPost() end to end, in-process, single-threaded, serial (D1/KV stubbed)',
      warmupCount: WARMUP,
      measuredCount: MEASURED,
      fixtureAcceptance: {
        aDurationTicks: a.ticks,
        aGameOverReason: a.reason,
        bSuccessDurationTicks: b100.ticks,
        bSuccessClaims: b100.claims,
        bRejectedClaims: b101.claims,
      },
      p99Ms: { A: by.A.p99Ms, Bsuccess: by.Bsuccess.p99Ms, Brejected: by.Brejected.p99Ms, Realistic: by.Realistic.p99Ms },
      combinedP99Ms: Number(combined.toFixed(2)),
      thresholdMs: 1000,
      verdict: combined <= 1000 ? 'PASS' : 'FAIL',
      suggestedCpuMsLimit: Math.ceil((combined * 2) / 1000) * 1000,
    };

    fs.writeFileSync(RESULTS, JSON.stringify({ summary, series: results }, null, 2));
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
    progress(`DONE combined p99 = ${by.A.p99Ms} + max(${by.Bsuccess.p99Ms}, ${by.Brejected.p99Ms}) = ${combined.toFixed(2)}ms vs 1000ms -> ${summary.verdict}`);
    progress(`suggested cpu_ms = ${summary.suggestedCpuMsLimit}`);
    progress(`wrote ${path.basename(RESULTS)} and ${path.basename(SUMMARY)}`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

void main();
