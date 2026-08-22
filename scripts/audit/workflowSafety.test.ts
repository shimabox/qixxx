// Guards the workflow's trigger-safety rule — `workflow_dispatch` is the
// only enabled trigger, and `schedule` stays commented out or guarded by an
// explicit enablement variable —
// against an accidental future edit that re-enables `schedule` without
// updating this guard — mirrors functions/_lib/ranking/benchHooks.test.ts's
// own pattern of reading a config file as text and asserting on it directly,
// rather than only documenting the intent in a comment.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.github/workflows/ranking-audit.yml');

describe('.github/workflows/ranking-audit.yml safety', () => {
  it('the file exists', () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
  });

  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = text.split('\n');
  // No YAML-parsing dependency is needed here: this repository has none,
  // and GitHub Actions' trigger syntax is simple enough for line-oriented
  // checks.
  // The regex matches UNCOMMENTED, top-level keys (2-space-indented under
  // `on:`) unambiguously for this specific file.
  const activeTriggerKeys = lines
    .map((line) => /^  ([A-Za-z_]+):/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);

  it('workflow_dispatch is an enabled (uncommented) trigger', () => {
    expect(activeTriggerKeys).toContain('workflow_dispatch');
  });

  it('schedule is NOT an active (uncommented, top-level) trigger', () => {
    expect(activeTriggerKeys).not.toContain('schedule');
  });

  it('the schedule trigger is still documented in a comment (so re-enabling it is a small, deliberate edit, not a rewrite)', () => {
    expect(text).toMatch(/#\s*schedule:/);
    expect(text).toMatch(/#\s*- cron:/);
  });

  it('the job itself is additionally guarded by an explicit AUDIT_CRON_ENABLED check (belt-and-braces alongside the commented-out trigger)', () => {
    expect(text).toMatch(/vars\.AUDIT_CRON_ENABLED/);
  });

  it('the enablement steps (real D1 connection, AUDIT_CRON_ENABLED, RANKING_IP_HASH_KEY secret) are documented in the file itself', () => {
    expect(text).toMatch(/AUDIT_CRON_ENABLED/);
    expect(text).toMatch(/RANKING_IP_HASH_KEY/);
    expect(text).toMatch(/RemoteD1Adapter/);
  });

  // Public-repository log hygiene (docs/ranking-audit-runbook.md §5): this
  // workflow's run log is world-readable, and AUDIT_LOG_ERROR_DETAIL opts the
  // audit job into printing exception MESSAGE text (paths, connection
  // details) — a local-debugging affordance only. Guarded here rather than
  // only in a comment, since setting it would be a one-line, plausible-
  // looking edit while debugging a red run.
  it('AUDIT_LOG_ERROR_DETAIL is not set anywhere in the workflow (uncommented)', () => {
    const uncommented = lines.filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(uncommented).not.toMatch(/AUDIT_LOG_ERROR_DETAIL/);
  });

  it('the public-log policy is pointed at from the file itself', () => {
    expect(text).toMatch(/ranking-audit-runbook\.md/);
    expect(text).toMatch(/AUDIT_LOG_ERROR_DETAIL/); // in the warning comment
  });
});
