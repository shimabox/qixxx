// Guards docs/plans/2026-08-19-ranking-free-async spec item 12's confirmed
// safety requirement ("workflow_dispatch のみを有効なトリガーとし、schedule
// はコメントアウトまたは明示的な有効化変数によるガードつきで定義する")
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
  // Deliberately no YAML-parsing dependency here (this repo's package.json
  // has none, and adding one is outside this round's "止まって報告すべき
  // 範囲" — request.md's "新規の依存パッケージ追加が必要になった場合"):
  // GitHub Actions' own trigger syntax is line-oriented enough that
  // matching UNCOMMENTED, top-level (2-space-indented, under `on:`) keys by
  // regex is unambiguous for this specific file.
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
});
