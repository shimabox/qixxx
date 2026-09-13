// MAX_VERIFIED_CLAIMS sizing harness. Two independent inputs to the cap
// decision (docs/ranking-runbook.md §4.3):
//
//   1. "How many claims do real runs make?" — every replay stored in the
//      local D1 (`wrangler pages dev` state, read with the sqlite3 CLI) is re-simulated and its claim
//      count reported next to its score. This is the NEEDED cap. Play runs
//      locally, submit them, re-run this script.
//   2. "What does a claim-heavy replay cost the audit?" — the SAFE cap. The
//      audit's per-row cost is (enemy simulation over 10800 ticks) + (claim
//      processing per claim). Fixture A isolates the first term (enemies at
//      their ceiling, marker idle, a huge life pool so the run lasts the full
//      time limit); fixture AB adds N tiny notch claims on top of that (kept
//      tiny so the unclaimed region — and so the flood-fill cost — stays as
//      large as possible). The per-claim slope is fitted across several N
//      and the worst-case row cost for candidate caps is projected as
//      pA + cap × slope, then multiplied out to MAX_GLOBAL_PENDING rows and
//      compared with the audit's AUDIT_MAX_RUNTIME_MS budget. Fixture B
//      (same claims, enemies frozen) is the reference showing how much of a
//      claim's cost is the Embers re-planning against the changed border.
//
// Fixture B needs the bench gameFactory, which production cannot reach, so
// it goes through simulateReplayFromRle() directly with the same
// MAX_VERIFIED_CLAIMS early-stop disabled (we WANT to count past the cap);
// the real-replay series uses the production verifyReplay() path for the
// claim count and the raw simulator for runs that exceed the cap.
//
// Wall-clock on this machine, single process, strictly serial. The audit
// runs on the operator's Mac too, so unlike the Cloudflare CPU-time
// measurements this number IS the quantity that matters — but it is
// machine-specific; record the machine with the result.
//
//   npx vite-node docs/measurements/measure-claim-cap.ts
//
// Writes claim-cap-<timestamp>.json (raw) and claim-cap-<timestamp>-summary.json.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Field } from '../../src/core/field';
import { Game, GameOptions } from '../../src/core/game';
import { Wisp, Rng } from '../../src/core/enemy';
import { getStageConfig } from '../../src/core/stage';
import { mulberry32 } from '../../src/core/rng';
import { GameSession, SessionOptions } from '../../src/core/session';
import { InputSample, encodeRle } from '../../src/core/rle';
import { simulateReplayFromRle } from '../../src/core/replayEngine';
import { verifyReplay } from '../../functions/_lib/ranking/verifyReplay';
import { GRID_WIDTH, GRID_HEIGHT, MAX_VERIFIED_CLAIMS, TIME_LIMIT_TICKS } from '../../src/config';
import { AUDIT_MAX_RUNTIME_MS, AUDIT_CHUNK_SIZE } from '../../scripts/audit/constants';

type Axis = -1 | 0 | 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS = path.join(HERE, `claim-cap-${STAMP}.json`);
const SUMMARY = path.join(HERE, `claim-cap-${STAMP}-summary.json`);

const WARMUP = 2;
const MEASURED = 5;
const BENCH_STAGE = 10;
const RNG_SEED = 424242;
const CLAIM_TARGETS = [0, 50, 100, 150, 200, 250];
const CANDIDATE_CAPS = [100, 150, 200, 300, 500, 1000];
/** Mirrors functions/api/scores.ts's MAX_GLOBAL_PENDING (module-private there). */
const MAX_GLOBAL_PENDING = 200;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.ceil(p * sorted.length)) - 1];
}

/**
 * Stage-10 board (the production difficulty ceiling, taken from
 * getStageConfig(10) rather than hand-picked numbers) built through
 * GameSession's bench-only `gameFactory` hook. `neutralized` keeps the enemy
 * objects but zeroes Wisp speed and freezes Embers, so claim processing
 * still enumerates them while enemy motion costs nothing — that is what
 * isolates claim cost. A very large life pool keeps the run going for the
 * full 10800 ticks whatever the scripted marker bumps into: miss handling is
 * O(1), so this does not cheapen the measured simulation, and the point is
 * the full-length worst case, not a bot that can survive stage 10.
 */
export function makeBenchGameFactory(neutralized: boolean): NonNullable<SessionOptions['gameFactory']> {
  return (_stage, carry) => {
    const config = getStageConfig(BENCH_STAGE);
    const field = new Field(GRID_WIDTH, GRID_HEIGHT);
    const markerStart = { x: Math.floor(field.getWidth() / 2), y: field.getHeight() - 1 };
    const rng: Rng = mulberry32(RNG_SEED);
    const cx = Math.floor(field.getWidth() / 2);
    const cy = Math.floor(field.getHeight() / 2);
    const wisps: Wisp[] = [];
    for (let i = 0; i < config.wispCount; i++) {
      wisps.push(new Wisp({ x: cx + Math.round((i - (config.wispCount - 1) / 2) * 3), y: cy }, rng, undefined, neutralized ? 0 : config.wispSpeedMultiplier));
    }
    const options: GameOptions = {
      wisps,
      emberSpawnIntervalTicks: config.emberSpawnIntervalTicks,
      emberMoveTicks: neutralized ? 1_000_000 : config.emberMoveTicks,
      emberBranchChaseProbability: neutralized ? 0 : config.emberBranchChaseProbability,
      maxConcurrentEmbers: config.maxConcurrentEmbers,
      requiredOccupancy: config.requiredOccupancy,
      score: carry.score,
      lives: 100_000,
      multiplier: carry.multiplier,
    };
    return new Game(field, markerStart, undefined, rng, options);
  };
}

/** Fixture A: enemies at their ceiling and moving; the marker idles on the border for the full time limit. */
function buildFixtureA(): Uint8Array {
  const session = new GameSession({ gameFactory: makeBenchGameFactory(false) });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  while (session.getTotalTicks() < TIME_LIMIT_TICKS && session.getStatus() === 'playing') {
    const s: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...s, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    samples.push(s);
  }
  return encodeRle(samples);
}

/**
 * Fixture B: neutralized enemies, `targetClaims` tiny notch claims along all
 * four borders (so the unclaimed interior stays almost whole and every
 * flood fill is near worst case), padded to the full time limit.
 */
export function buildFixtureB(targetClaims: number, neutralized = true): { rle: Uint8Array; claims: number; ticks: number } {
  const session = new GameSession({ gameFactory: makeBenchGameFactory(neutralized) });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const field = session.getGame().getField();
  const W = field.getWidth();
  const H = field.getHeight();
  const samples: InputSample[] = [];
  let claims = 0;

  const push = (dx: Axis, dy: Axis, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    for (const ev of session.drainEvents()) if (ev === 'area-claimed') claims++;
    session.drainDespawnedEmberPositions();
  };
  const pos = () => session.getGame().getMarker().getPosition();
  const playing = () => session.getStatus() === 'playing';

  // Walk along the border (never drawing) to (x, y), which must itself be a
  // border cell: first to the right column/row, then along it.
  const travelTo = (x: number, y: number): void => {
    let p = pos();
    const onRow = p.y === 0 || p.y === H - 1;
    if (onRow && p.y !== y) {
      const sideX = p.x < W / 2 ? 0 : W - 1;
      while (pos().x !== sideX && playing()) push(pos().x < sideX ? 1 : -1, 0, false);
      while (pos().y !== y && playing()) push(0, pos().y < y ? 1 : -1, false);
    } else if (!onRow && p.x !== x) {
      const sideY = p.y < H / 2 ? 0 : H - 1;
      while (pos().y !== sideY && playing()) push(0, pos().y < sideY ? 1 : -1, false);
      while (pos().x !== x && playing()) push(pos().x < x ? 1 : -1, 0, false);
    }
    p = pos();
    while ((p.x !== x || p.y !== y) && playing()) {
      if (p.x !== x) push(p.x < x ? 1 : -1, 0, false);
      else push(0, p.y < y ? 1 : -1, false);
      p = pos();
    }
  };

  const depth = 3;
  const pitch = 2;
  type Slot = { x: number; y: number; dive: { dx: Axis; dy: Axis }; side: { dx: Axis; dy: Axis } };
  const slots: Slot[] = [];
  for (let x = 2; x <= W - 4; x += pitch) slots.push({ x, y: 0, dive: { dx: 0, dy: 1 }, side: { dx: 1, dy: 0 } });
  for (let x = 2; x <= W - 4; x += pitch) slots.push({ x, y: H - 1, dive: { dx: 0, dy: -1 }, side: { dx: 1, dy: 0 } });
  for (let y = depth + 3; y <= H - depth - 5; y += pitch) slots.push({ x: 0, y, dive: { dx: 1, dy: 0 }, side: { dx: 0, dy: 1 } });
  for (let y = depth + 3; y <= H - depth - 5; y += pitch) slots.push({ x: W - 1, y, dive: { dx: -1, dy: 0 }, side: { dx: 0, dy: 1 } });

  for (const slot of slots) {
    if (claims >= targetClaims || !playing() || samples.length > TIME_LIMIT_TICKS - 400) break;
    travelTo(slot.x, slot.y);
    if (!playing()) break;
    const before = claims;
    for (let i = 0; i < depth; i++) push(slot.dive.dx, slot.dive.dy, true);
    push(slot.side.dx, slot.side.dy, true);
    for (let i = 0; i < depth + 1 && claims === before && playing(); i++) push(-slot.dive.dx as Axis, -slot.dive.dy as Axis, true);
  }
  while (session.getTotalTicks() < TIME_LIMIT_TICKS && playing()) push(0, 0, false);
  return { rle: encodeRle(samples), claims, ticks: session.getTotalTicks() };
}

export function timeSim(seed: number, rle: Uint8Array, gameFactory: SessionOptions['gameFactory']): { ms: number; claims: number; ticks: number } {
  const t0 = performance.now();
  const r = simulateReplayFromRle(seed, rle, { gameFactory });
  return { ms: performance.now() - t0, claims: r.totalClaims, ticks: r.durationTicks };
}

function series(label: string, run: () => { ms: number; claims: number; ticks: number }) {
  for (let i = 0; i < WARMUP; i++) run();
  const ms: number[] = [];
  let last = { claims: 0, ticks: 0 };
  for (let i = 0; i < MEASURED; i++) {
    const r = run();
    ms.push(r.ms);
    last = { claims: r.claims, ticks: r.ticks };
  }
  const out = { label, claims: last.claims, ticks: last.ticks, samplesMs: ms, p50Ms: percentile(ms, 0.5), maxMs: Math.max(...ms) };
  log(`${label}: claims=${out.claims} ticks=${out.ticks} p50=${out.p50Ms.toFixed(1)}ms max=${out.maxMs.toFixed(1)}ms`);
  return out;
}

/** Least-squares slope/intercept of y on x. */
function fit(points: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const sxy = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * Every `scores` row in every local D1 database under .wrangler/state/v3/d1
 * (wrangler keys the SQLite file by database id, so a dev database created
 * under an older id is still picked up). Read with the sqlite3 CLI so this
 * does not depend on which id wrangler.toml currently names.
 */
function realReplays() {
  const d1Dir = path.join(REPO_ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
  if (!fs.existsSync(d1Dir)) {
    log('no local D1 state found — skipping real-replay series');
    return [];
  }
  const files = fs.readdirSync(d1Dir).filter((f) => f.endsWith('.sqlite'));
  const rows = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = execFileSync('sqlite3', [path.join(d1Dir, file), '-json', `SELECT id, seed, score, stage, status, created_at, hex(inputs) AS inputs_hex FROM scores ORDER BY rank_seq`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch {
      continue; // no scores table in this database
    }
    if (raw.trim() === '') continue;
    const parsed = JSON.parse(raw) as { id: string; seed: number; score: number; stage: number; status: string; created_at: number; inputs_hex: string }[];
    for (const row of parsed) {
      const rle = Uint8Array.from(Buffer.from(row.inputs_hex, 'hex'));
      const t0 = performance.now();
      const verified = verifyReplay(row.seed, rle);
      const verifyMs = performance.now() - t0;
      // verifyReplay() stops at the cap; the raw simulator reports the true count.
      const sim = simulateReplayFromRle(row.seed, rle, {});
      rows.push({
        db: file.slice(0, 8),
        id: row.id,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        submittedScore: row.score,
        submittedStage: row.stage,
        simScore: sim.score,
        simStage: sim.stage,
        durationTicks: sim.durationTicks,
        claims: sim.totalClaims,
        reachedGameOver: sim.reachedGameOver,
        verify: verified.ok ? 'ok' : verified.reason,
        verifyMs,
      });
      log(`real ${row.id.slice(0, 8)}: score=${sim.score} stage=${sim.stage} ticks=${sim.durationTicks} claims=${sim.totalClaims} verify=${verified.ok ? 'ok' : verified.reason} (${verifyMs.toFixed(1)}ms)`);
    }
  }
  return rows;
}

async function main() {
  log(`machine: ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}, node ${process.version}, MAX_VERIFIED_CLAIMS=${MAX_VERIFIED_CLAIMS}`);

  log('--- 1. real replays in local D1 ---');
  const real = realReplays();

  log('--- 2. fixture A (enemy ceiling, idle marker) ---');
  const rleA = buildFixtureA();
  const a = series('A', () => timeSim(RNG_SEED, rleA, makeBenchGameFactory(false)));

  // Claim cost is NOT independent of enemy activity: every claim changes the
  // border, and each active Ember re-plans against the new border, so a claim
  // made with ten stage-10 Embers patrolling costs several times one made with
  // frozen Embers. The worst case the audit can meet is therefore "enemies at
  // their ceiling AND claims", which is what the AB series measures and what
  // the projections use. The frozen-enemy B series is kept as the reference
  // that shows how much of the per-claim cost is that Ember re-planning.
  log('--- 3. fixture AB (enemy ceiling moving, N notch claims) — the worst case ---');
  const ab = [];
  for (const target of CLAIM_TARGETS) {
    const built = buildFixtureB(target, false);
    if (built.claims < target) log(`AB target=${target}: bot reached only ${built.claims} claims (border slots exhausted)`);
    ab.push(series(`AB${target}`, () => timeSim(RNG_SEED, built.rle, makeBenchGameFactory(false))));
  }
  const fittedAb = fit(ab.map((s) => ({ x: s.claims, y: s.p50Ms })));
  const perClaimMs = fittedAb.slope;
  log(`per-claim cost with active enemies (least squares over p50): ${perClaimMs.toFixed(2)} ms/claim; intercept ${fittedAb.intercept.toFixed(1)}ms (A measured ${a.p50Ms.toFixed(1)}ms)`);

  log('--- 4. fixture B (frozen enemies, N notch claims) — reference: claim processing alone ---');
  const b = [];
  for (const target of [0, MAX_VERIFIED_CLAIMS]) {
    const built = buildFixtureB(target, true);
    b.push(series(`B${target}`, () => timeSim(RNG_SEED, built.rle, makeBenchGameFactory(true))));
  }
  const perClaimFrozenMs = (b[1].p50Ms - b[0].p50Ms) / Math.max(1, b[1].claims);
  log(`per-claim cost with frozen enemies: ${perClaimFrozenMs.toFixed(2)} ms/claim (${((perClaimFrozenMs / perClaimMs) * 100).toFixed(0)}% of the active-enemy cost)`);

  // Smallest possible notch is dive 1 + side 1 + return 1 = 3 ticks, plus at
  // least 1 tick of travel between slots: the time budget alone bounds claims.
  const theoreticalMaxClaims = Math.floor(TIME_LIMIT_TICKS / 4);

  // Project on the CONSERVATIVE (larger) per-claim slope. The active-enemy
  // series is the realistic worst case but is noisy on a loaded machine; the
  // frozen series is stable. Taking the max keeps the projection from
  // under-stating the audit cost when the active run happened to measure low.
  const conservativePerClaimMs = Math.max(perClaimMs, perClaimFrozenMs);
  const projections = CANDIDATE_CAPS.map((cap) => {
    const worstRowMs = a.p50Ms + cap * conservativePerClaimMs;
    const worstRowMaxMs = a.maxMs + cap * conservativePerClaimMs;
    const fullQueueMs = worstRowMs * MAX_GLOBAL_PENDING;
    return {
      cap,
      worstRowMs,
      worstRowMaxMs,
      chunkMs: worstRowMs * AUDIT_CHUNK_SIZE,
      fullQueueMs,
      fullQueueWithinBudget: fullQueueMs <= AUDIT_MAX_RUNTIME_MS,
      auditRunsToDrainFullQueue: Math.ceil(fullQueueMs / AUDIT_MAX_RUNTIME_MS),
    };
  });
  for (const p of projections) {
    log(
      `cap=${p.cap}: worst row ≈ ${(p.worstRowMs / 1000).toFixed(2)}s, chunk(${AUDIT_CHUNK_SIZE}) ≈ ${(p.chunkMs / 1000).toFixed(0)}s, full queue(${MAX_GLOBAL_PENDING}) ≈ ${(p.fullQueueMs / 1000).toFixed(0)}s → ${p.auditRunsToDrainFullQueue} audit run(s) of ${AUDIT_MAX_RUNTIME_MS / 1000}s`
    );
  }

  const summary = {
    measuredAt: new Date().toISOString(),
    machine: { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.release()}` },
    constants: { MAX_VERIFIED_CLAIMS, TIME_LIMIT_TICKS, MAX_GLOBAL_PENDING, AUDIT_CHUNK_SIZE, AUDIT_MAX_RUNTIME_MS },
    realReplays: { count: real.length, maxClaims: real.length ? Math.max(...real.map((r) => r.claims)) : null, rows: real },
    fixtureA: { ticks: a.ticks, p50Ms: a.p50Ms, maxMs: a.maxMs },
    fixtureAB: ab.map(({ label, claims, p50Ms, maxMs }) => ({ label, claims, p50Ms, maxMs })),
    fixtureBFrozen: b.map(({ label, claims, p50Ms, maxMs }) => ({ label, claims, p50Ms, maxMs })),
    perClaimMs,
    perClaimFrozenMs,
    conservativePerClaimMs,
    fitIntercomparison: { abIntercept: fittedAb.intercept, aMeasured: a.p50Ms },
    theoreticalMaxClaims,
    projections,
  };
  fs.writeFileSync(RESULTS, JSON.stringify({ summary, raw: { a, b, ab } }, null, 2));
  fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  log(`wrote ${path.basename(RESULTS)} and ${path.basename(SUMMARY)}`);
}

if (!process.env.CLAIM_CAP_NO_MAIN) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
