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
