import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts', 'scripts/**/*.test.ts', 'migrations/**/*.test.ts'],
    // Real-D1 integration
    // tests (scripts/audit/*.test.ts) each spawn `wrangler d1 migrations
    // apply` against their own throwaway local database — slower than the
    // rest of this suite's pure-function/mocked-D1 tests, so they get a more
    // generous timeout than vitest's 5s default rather than flaking under
    // load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Real-D1 integration
    // tests (scripts/audit/*.test.ts, functions/_lib/ranking/
    // scoresConcurrency.test.ts, migrations/*.test.ts) each spin up their own
    // wrangler getPlatformProxy() D1 instance. Running more than one such
    // instance concurrently (vitest's default per-file parallelism, across
    // worker threads) was observed to corrupt Miniflare's internal
    // synchronous RPC proxy ("message?.id === id" assertion failures inside
    // node_modules/miniflare's fetch-sync client) — a Miniflare-side
    // limitation of running multiple proxies at once in the same test run,
    // not a bug in this suite's own code (each test file's D1 instance is
    // otherwise fully isolated — its own --persist-to temp directory). Test
    // FILES therefore run serially; tests WITHIN a file still run in the
    // normal order vitest already used. The `describe.concurrent`-style
    // in-file concurrency this project doesn't use is unaffected.
    fileParallelism: false,
  },
});
