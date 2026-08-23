import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.github/workflows/ranking-audit.yml');

describe('.github/workflows/ranking-audit.yml safety', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = text.split('\n');
  const uncommented = lines.filter((line) => !/^\s*#/.test(line)).join('\n');

  it('enables manual runs and the exact hourly backup schedule', () => {
    expect(text).toMatch(/^ {2}workflow_dispatch: \{\}$/m);
    expect(text).toMatch(/^ {2}schedule:$/m);
    expect(text).toMatch(/^ {4}- cron: '23 \* \* \* \*'$/m);
    expect(text.match(/- cron:/g)).toHaveLength(1);
  });

  it('guards both manual and scheduled jobs to main and gates schedules with the repository variable', () => {
    expect(text).toContain("if: github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || vars.AUDIT_CRON_ENABLED == 'true')");
  });

  it('uses the remote npm command with the required Secret and Variable sources', () => {
    expect(text).toMatch(/^ {8}run: npm run ranking:remote:audit$/m);
    expect(text).toMatch(/^ {10}CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/m);
    expect(text).toMatch(/^ {10}RANKING_IP_HASH_KEY: \$\{\{ secrets\.RANKING_IP_HASH_KEY \}\}$/m);
    expect(text).toMatch(/^ {10}CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}$/m);
    expect(text).toMatch(/^ {10}CLOUDFLARE_D1_DATABASE_ID: \$\{\{ vars\.CLOUDFLARE_D1_DATABASE_ID \}\}$/m);
    expect(text).toMatch(/^ {10}AUDIT_CRON_ENABLED: \$\{\{ vars\.AUDIT_CRON_ENABLED \}\}$/m);
  });

  it('keeps non-cancelling concurrency and never enables error message detail', () => {
    expect(text).toMatch(/^ {2}group: ranking-audit$/m);
    expect(text).toMatch(/^ {2}cancel-in-progress: false$/m);
    expect(uncommented).not.toMatch(/AUDIT_LOG_ERROR_DETAIL/);
  });

  it('points operators to the runbook', () => {
    expect(text).toMatch(/docs\/ranking-audit-runbook\.md/);
  });
});
