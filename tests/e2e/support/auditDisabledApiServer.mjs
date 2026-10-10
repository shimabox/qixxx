// Starts a real Pages Functions server (`wrangler pages dev`) for the E2E
// suite with RANKING_AUDIT_MODE=disabled, on its own throwaway, freshly
// migrated local D1 — never the shared `.wrangler/state/` a developer's own
// `wrangler pages dev` uses. Launched by playwright.config.ts's webServer list;
// tests/e2e/ranking.spec.ts forwards the page's /api/* calls here.
//
// Only the API matters: the static directory is `public/` simply because
// `wrangler pages dev` needs one, and the game itself is still served by the
// Vite dev server.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = process.env.AUDIT_DISABLED_API_PORT ?? '8790';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };

const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qixxx-e2e-audit-disabled-d1-'));
const removePersistDir = () => fs.rmSync(persistDir, { recursive: true, force: true });

try {
  execFileSync(NPX, ['wrangler', 'd1', 'migrations', 'apply', 'qixxx-scores', '--local', '--persist-to', persistDir], {
    cwd: REPO_ROOT,
    env: childEnv,
    input: 'y\n',
    stdio: ['pipe', 'ignore', 'inherit'],
  });
} catch (err) {
  removePersistDir();
  throw err;
}

const server = spawn(
  NPX,
  [
    'wrangler',
    'pages',
    'dev',
    'public',
    '--ip',
    '127.0.0.1',
    '--port',
    PORT,
    '--persist-to',
    persistDir,
    // Command-line bindings override `.dev.vars`, so a developer's own local
    // settings cannot change what this suite tests.
    '--binding',
    'RANKING_AUDIT_MODE=disabled',
    '--binding',
    'RANKING_IP_HASH_KEY=e2e-audit-disabled-only-key',
    '--show-interactive-dev-session=false',
  ],
  { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] }
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code, signal) => {
  removePersistDir();
  process.exit(code ?? (signal ? 1 : 0));
});
