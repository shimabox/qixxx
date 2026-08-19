// LOCAL IN-PROCESS WALL-CLOCK BENCHMARK for the Free-tier async-audit
// version of POST /api/scores (docs/plans/2026-08-19-ranking-free-async
// task 8). Sibling to measure-post-cpu.ts (the Paid/synchronous-verification
// version's own harness, left untouched on this branch — see this file's own
// module comment for why this is a NEW file rather than an edit to that one)
// — same role, same reporting shape, adapted for the pending-POST contract:
// no verifyReplay()/resimulation happens on this path AT ALL (structurally —
// see functions/_lib/ranking/scoresEndpoint.test.ts's spy-based test for the
// machine-checked version of that claim), so there is no "max enemy load"
// fixture to build here. What POST /api/scores now actually spends CPU on
// is: JSON parsing, score/stage/seed validation, an RLE DECODE-ONLY pass
// (functions/_lib/ranking/rleDuration.ts) for duration_ticks, and the
// existing replay_hash computation (functions/_lib/ranking/hash.ts — decode
// + canonical re-encode + SHA-256, unchanged from the Paid version). D1/KV
// are in-memory mocks, exactly like measure-post-cpu.ts's own — this is a
// LOCAL reference figure, not a Cloudflare CPU-time measurement (see this
// feature's request.md/plan.md for why the two are deliberately kept
// separate; Free 10ms viability was already settled by task 1's real
// Cloudflare measurement, not by this harness).
//
// Run from the repo root:
//
//   npx vite-node docs/measurements/measure-pending-post-cpu.ts
//
// Writes, all from ONE process, into this directory:
//   pending-post-cpu-<stamp>.progress.txt / .json / -summary.json
import { onRequestPost } from '../../functions/api/scores';
import { GameSession, SessionOptions } from '../../src/core/session';
import { InputSample, encodeRle } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION, MAX_INPUT_SAMPLES } from '../../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const PROGRESS = path.join(HERE, `pending-post-cpu-${STAMP}.progress.txt`);
const RESULTS = path.join(HERE, `pending-post-cpu-${STAMP}.json`);
const SUMMARY = path.join(HERE, `pending-post-cpu-${STAMP}-summary.json`);
const LOCK = path.join(HERE, '.measure-pending-post-cpu.lock');

const WARMUP = 10;
const MEASURED = 100;
const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'bench-only-hmac-key';

function progress(msg: string): void {
  const line = `[${new Date().toISOString()}] [pid ${process.pid}] ${msg}`;
  console.log(line);
  fs.appendFileSync(PROGRESS, line + '\n');
}

function nearestRankP99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.ceil(0.99 * sorted.length)) - 1];
}

/** Fixture WORST: MAX_INPUT_SAMPLES (10800) ticks, alternating every sample so RLE compresses to nothing — maximizes decode/hash iteration count, the worst case for the decode-only duration derivation + replay_hash computation this path actually pays for. */
function buildFixtureWorst(): { rle: Uint8Array; sampleCount: number } {
  const samples: InputSample[] = [];
  for (let i = 0; i < MAX_INPUT_SAMPLES; i++) {
    samples.push({ dx: i % 2 === 0 ? 1 : -1, dy: 0, drawHeld: i % 3 === 0, slow: i % 5 === 0 });
  }
  return { rle: encodeRle(samples), sampleCount: samples.length };
}

/** Fixture R: an ordinary stage-1 run's real recorded input stream — the true "typical POST" case. */
function buildFixtureRealistic(seed: number): { rle: Uint8Array; sampleCount: number } {
  const session = new GameSession({ seed } as SessionOptions);
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
  return { rle: encodeRle(samples), sampleCount: samples.length };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return Buffer.from(binary, 'binary').toString('base64');
}

/** In-memory D1/KV stubs (mirrors measure-post-cpu.ts's own): the handler's SQL is still prepared and bound, only the I/O is elided. Threshold is fixed at -1 (COALESCE default) so every measured request takes the accept path (never the pre-gate's early-return, whose cost this harness is not trying to isolate). */
function makeEnv() {
  const kv = new Map<string, string>();
  let idSeq = 0;
  return {
    SHARES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async () => undefined, // rate limiting bypassed, same rationale as measure-post-cpu.ts
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => ({ threshold: -1 }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
      // unused by the accept path directly (bind().run() covers the INSERT), kept for shape completeness
      batch: async () => [],
    },
    RANKING_IP_HASH_KEY: IP_HASH_KEY,
    _nextId: () => `bench-${idSeq++}`,
  };
}

async function postOnce(env: ReturnType<typeof makeEnv>, seed: number, rleBase64: string) {
  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${seed % 250}` },
    body: JSON.stringify({
      seed,
      rleBase64,
      score: 100,
      stage: 1,
      name: 'BENCH',
      rulesetVersion: RULESET_VERSION,
      replayFormatVersion: REPLAY_FORMAT_VERSION,
    }),
  });
  type Ctx = Parameters<typeof onRequestPost>[0];
  const t0 = performance.now();
  const response = await onRequestPost({ request, env, params: {} } as unknown as Ctx);
  const body = (await response.json()) as Record<string, unknown>;
  const ms = performance.now() - t0;
  return { ms, status: response.status, body };
}

interface SeriesSpec {
  name: string;
  description: string;
  seed: number;
  rleBase64: string;
  expectedDurationTicks: number;
}

async function measureSeries(spec: SeriesSpec) {
  const env = makeEnv();
  progress(`[${spec.name}] warmup (${WARMUP} requests, serial)...`);
  for (let i = 0; i < WARMUP; i++) {
    const r = await postOnce(env, spec.seed, spec.rleBase64);
    if (r.status !== 200 || r.body.accepted !== true || r.body.durationTicks !== spec.expectedDurationTicks) {
      throw new Error(`[${spec.name}] warmup request did not meet expectation: ${JSON.stringify(r)}`);
    }
  }

  progress(`[${spec.name}] measuring (${MEASURED} requests, serial)...`);
  const samples: number[] = [];
  for (let i = 0; i < MEASURED; i++) {
    const { ms, status, body } = await postOnce(env, spec.seed, spec.rleBase64);
    if (status !== 200 || body.accepted !== true || body.durationTicks !== spec.expectedDurationTicks) {
      throw new Error(`[${spec.name}] measured request #${i + 1} did not meet expectation: ${JSON.stringify({ status, body })}`);
    }
    samples.push(ms);
    if ((i + 1) % 20 === 0) progress(`[${spec.name}] ${i + 1}/${MEASURED} done (last=${ms.toFixed(2)}ms)`);
  }

  const p99 = nearestRankP99(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  progress(`[${spec.name}] p99=${p99.toFixed(2)}ms mean=${mean.toFixed(2)}ms min=${Math.min(...samples).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms`);
  return {
    series: spec.name,
    description: spec.description,
    warmupCount: WARMUP,
    measuredCount: MEASURED,
    p99Ms: Number(p99.toFixed(2)),
    meanMs: Number(mean.toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
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
    progress(`START single-process serial pending-POST measurement (node ${process.version})`);
    progress('building fixtures...');

    const worst = buildFixtureWorst();
    const realistic = buildFixtureRealistic(4242);
    progress(`fixtures: worst sampleCount=${worst.sampleCount} rleBytes=${worst.rle.length} | realistic sampleCount=${realistic.sampleCount} rleBytes=${realistic.rle.length}`);

    const results = [
      await measureSeries({
        name: 'Worst',
        description: `MAX_INPUT_SAMPLES (${MAX_INPUT_SAMPLES}) ticks, non-compressible (worst case for the RLE decode-only duration derivation + replay_hash computation)`,
        seed: 1,
        rleBase64: bytesToBase64(worst.rle),
        expectedDurationTicks: worst.sampleCount,
      }),
      await measureSeries({
        name: 'Realistic',
        description: 'An ordinary stage-1 run\'s real recorded input stream — the typical pending POST',
        seed: 4242,
        rleBase64: bytesToBase64(realistic.rle),
        expectedDurationTicks: realistic.sampleCount,
      }),
    ];

    const by = Object.fromEntries(results.map((x) => [x.series, x]));
    const summary = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      measures:
        'POST /api/scores onRequestPost() end to end, Free-tier async-audit version (no verifyReplay()/resimulation — see functions/_lib/ranking/scoresEndpoint.test.ts\'s spy-based structural test), in-process, single-threaded, serial (D1/KV stubbed)',
      warmupCount: WARMUP,
      measuredCount: MEASURED,
      p99Ms: { Worst: by.Worst.p99Ms, Realistic: by.Realistic.p99Ms },
      thresholdMs: 5,
      verdict: by.Worst.p99Ms <= 5 && by.Realistic.p99Ms <= 5 ? 'PASS (reference only — see this file\'s own module comment: not the Free 10ms determination)' : 'ABOVE 5ms REFERENCE TARGET (reference only)',
    };

    fs.writeFileSync(RESULTS, JSON.stringify({ summary, series: results }, null, 2));
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
    progress(`DONE p99 Worst=${by.Worst.p99Ms}ms Realistic=${by.Realistic.p99Ms}ms vs 5ms reference target -> ${summary.verdict}`);
    progress(`wrote ${path.basename(RESULTS)} and ${path.basename(SUMMARY)}`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

void main();
