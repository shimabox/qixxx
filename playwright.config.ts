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
  // Capped (not left at the CPU-count-based default, which measured 4 on an
  // 8-core dev machine) after diagnosing an intermittent full-suite flake
  // (docs/plans/2026-08-16-score-ranking task 5 stabilization): several
  // specs drive real, wall-clock-timed gameplay with tight-ish timing
  // margins (tests/e2e/gameover-share.spec.ts's 8s post-miss window,
  // tests/e2e/smoke.spec.ts's 10s claim window) — confirmed via repeated
  // full-suite runs that *both* intermittently miss their own budget under
  // 4-way parallel CPU contention even independent of any other spec (this
  // reproduces with only the suite's pre-existing files, before
  // tests/e2e/ranking.spec.ts's own real-gameplay-driven tests are even
  // added to the mix — not a defect introduced by either). 2 keeps
  // meaningful parallelism while giving each real-time-sensitive test
  // enough headroom; verified stable across repeated full-suite runs at
  // this value where 4 was not.
  workers: 2,
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
