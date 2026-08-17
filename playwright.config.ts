import { defineConfig, devices } from '@playwright/test';

// E2E smoke tests only (docs/plan.md §7.2): "ゲームプレイの自動E2Eは費用対
// 効果が低い" — kept to the 4 documented scenarios, local Chromium only.
// Lives outside src/ (and outside tsconfig's `include`) on purpose: it's a
// tooling config, not part of the app being type-checked/bundled by
// `npm run typecheck`/`npm run build`.
const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  // Serialized (not left at the CPU-count-based default, which measured 4 on
  // an 8-core dev machine) because several specs drive real, wall-clock-timed
  // gameplay against budgets that CPU contention can blow:
  // tests/e2e/gameover-share.spec.ts polls an 8s post-miss window,
  // tests/e2e/smoke.spec.ts a 10s claim window. Both are pre-existing files
  // this feature branch must not edit, and both were confirmed (repeated
  // full-suite runs, docs/plans/2026-08-16-score-ranking task 5
  // stabilization) to intermittently miss their own budget under parallel
  // load *with only the suite's pre-existing files present*, before
  // tests/e2e/ranking.spec.ts's real-gameplay tests were added — i.e. this
  // is contention, not a defect in any spec.
  //
  // Dropping 4 -> 2 made it rarer but not gone: review round 3 still caught
  // both of them failing, once each, across ~40 full-suite runs — always as
  // a bare "Timeout Nms exceeded" on a gameplay poll, never a wrong value.
  // 1 removes the cross-worker CPU contention that causes it outright, which
  // is worth roughly a minute of extra wall-clock on a suite this small:
  // an E2E gate is only useful if green means green.
  //
  // (Round 3 also cut the ranking spec's own gameplay driver from ~30
  // page.evaluate() round trips per second to ~3, so this file contributes
  // far less load than it used to — that reduction alone was not sufficient
  // to make the pre-existing budgets reliable.)
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // No `use.baseURL`: tests/e2e/smoke.spec.ts navigates with the full
  // literal URL (matching BASE_URL below) rather than a relative path, to
  // sidestep baseURL's leading-slash-resets-the-path resolution surprise
  // when the app is served under a non-root `base` (vite.config.ts's
  // `base: '/'`).
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Vite's dev server (not a production build) is enough for a smoke
    // suite and starts faster; it already serves under `base: '/'`
    // exactly like the production build does (vite.config.ts).
    command: `npx vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
