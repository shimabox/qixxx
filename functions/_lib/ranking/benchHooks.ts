// Benchmark-only state injection for the POST /api/scores verification path
// (docs/ranking-cpu-measurement.md). This is what lets the CPU harness build
// the "max enemy load" / "max claim load" fixtures the measurement protocol
// calls for, while measuring them through the REAL handler rather than a
// stripped-down copy of it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS UNREACHABLE IN PRODUCTION
// ---------------------------------------------------------------------------
// Two independent locks, the second of which is structural:
//
//  1. `BENCH_HOOKS` must be exactly 'enabled'. wrangler.toml defines no such
//     binding — verified by functions/_lib/ranking/benchHooks.test.ts, which
//     reads wrangler.toml and asserts neither name appears in it.
//
//  2. `BENCH_GAME_FACTORY` must be an actual JavaScript FUNCTION hanging off
//     the env object. Cloudflare bindings are strings, KV/D1/R2 handles and
//     the like — there is no binding type, and no request body, header or
//     query string, that can deliver a live function into `env`. The hook can
//     therefore only be armed by code running in the same process that
//     constructs `env` itself, i.e. the harness. No remote caller can reach
//     it, however the flag is set.
//
// This mirrors the isolation rule already applied to SessionOptions.gameFactory
// in src/core: a bench/test-only injection point that production code passes
// through but never populates.
import type { SessionOptions } from '../../../src/core/session';

export interface BenchVerifyHooks {
  gameFactory?: SessionOptions['gameFactory'];
}

/**
 * Returns the bench hooks if — and only if — this process explicitly armed
 * them. Returns undefined for every production-shaped env. Deliberately
 * total: any unexpected shape yields undefined rather than throwing, so a
 * malformed env can never turn into a 500 on the live path.
 */
export function resolveBenchHooks(env: unknown): BenchVerifyHooks | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const candidate = env as { BENCH_HOOKS?: unknown; BENCH_GAME_FACTORY?: unknown };
  if (candidate.BENCH_HOOKS !== 'enabled') return undefined;
  if (typeof candidate.BENCH_GAME_FACTORY !== 'function') return undefined;
  return { gameFactory: candidate.BENCH_GAME_FACTORY as SessionOptions['gameFactory'] };
}
