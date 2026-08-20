// Guards the audit entrypoint's public-log contract (docs/ranking-audit-
// runbook.md §5 "ログ方針") at the process boundary: whatever goes wrong, the
// bytes this command writes to stdout/stderr must never include a stack, an
// absolute path or a raw error message — because a public repository's GitHub
// Actions run log is world-readable.
//
// The interesting case (user review, 2026-08-20) is a throw during MODULE
// INITIALIZATION. scripts/audit/constants.ts asserts its lease/runtime
// invariant with a top-level `throw`, and with a statically-imported command
// body that throw would fire before the entrypoint's own catch existed,
// leaving the runner to print a raw stack. cli.ts therefore loads the command
// through a DYNAMIC import; these tests check both that it still does, and
// that such a throw really is sanitized end-to-end in a real subprocess.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUDIT_DIR = path.join(REPO_ROOT, 'scripts/audit');
const CLI_PATH = path.join(AUDIT_DIR, 'cli.ts');
const CLI_SOURCE = fs.readFileSync(CLI_PATH, 'utf8');

/** Static import specifiers (both `import x from '...'` and bare `import '...'`) of a module's source. */
function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^import\s+(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) specifiers.push(match[1]);
  return specifiers;
}

/** Runs a vite-node entrypoint to completion and returns everything an operator (or the public) would see. */
function runEntrypoint(entryPath: string, env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite-node', entryPath], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

/** The assertions that apply to EVERY exit path of this command, successful or not. */
function assertPublishableOutput(output: string): void {
  expect(output).not.toMatch(/\bat\s+\S+\s+\(?\S*:\d+:\d+\)?/); // stack frames ("at foo (/path/file.ts:1:2)")
  expect(output).not.toMatch(/^\s+at\s/m);
  expect(output).not.toMatch(/\/(Users|home|root)\//); // absolute paths
  expect(output).not.toMatch(/node_modules/);
}

describe('scripts/audit/cli.ts (the entrypoint as a process)', () => {
  const generated: string[] = [];

  afterEach(() => {
    while (generated.length > 0) fs.rmSync(generated.pop()!, { force: true });
  });

  /** Writes a throwaway module NEXT TO cli.ts (so the bootstrap's own relative imports still resolve) and schedules its deletion. */
  function writeTempModule(basename: string, source: string): string {
    const filePath = path.join(AUDIT_DIR, `__tmp_${basename}.${process.pid}.ts`);
    fs.writeFileSync(filePath, source, 'utf8');
    generated.push(filePath);
    return filePath;
  }

  describe('shape: it is a bootstrap, not the command', () => {
    it('statically imports ONLY ./logSafety — everything else must be loaded dynamically, inside the sanitizing catch', () => {
      expect(staticImportSpecifiers(CLI_SOURCE)).toEqual(['./logSafety']);
    });

    it('loads the command body through a dynamic import', () => {
      expect(CLI_SOURCE).toMatch(/await import\(['"]\.\/auditCommand['"]\)/);
    });

    it('the one statically-imported module is itself dependency-free (nothing of ITS import graph can throw first)', () => {
      const logSafetySource = fs.readFileSync(path.join(AUDIT_DIR, 'logSafety.ts'), 'utf8');
      expect(staticImportSpecifiers(logSafetySource)).toEqual([]);
    });
  });

  describe('behavior: no exit path prints a stack, a path or a raw message', () => {
    it('a module-initialization throw in the command body is sanitized (the case a static import would have leaked)', () => {
      // Mirrors scripts/audit/constants.ts's real top-level invariant throw,
      // with a message deliberately full of things that must not be published.
      const throwingModule = writeTempModule(
        'initThrow',
        [
          "export const unused = 1;",
          "throw new Error('invariant violated: connect ECONNREFUSED 10.1.2.3:5432 /Users/someone/qixxx/secret.sqlite');",
          '',
        ].join('\n')
      );
      // The REAL bootstrap source, with only its dynamic-import target
      // swapped — so what runs below is cli.ts's own code, not a lookalike.
      const bootstrap = writeTempModule('bootstrap', CLI_SOURCE.replace("'./auditCommand'", `'./${path.basename(throwingModule, '.ts')}'`));
      expect(fs.readFileSync(bootstrap, 'utf8')).toContain('__tmp_initThrow');

      const { status, output } = runEntrypoint(bootstrap, envWithout('AUDIT_LOG_ERROR_DETAIL'));

      expect(output).toContain('[audit] fatal error: Error (re-run locally with AUDIT_LOG_ERROR_DETAIL=1');
      expect(output).not.toContain('ECONNREFUSED');
      expect(output).not.toContain('10.1.2.3');
      expect(output).not.toContain('secret.sqlite');
      expect(output).not.toContain('invariant violated');
      assertPublishableOutput(output);
      expect(status).toBe(1);
    });

    it('the same throw, with the local opt-in set, adds the message first line and still no stack', () => {
      const throwingModule = writeTempModule('initThrow', ["export const unused = 1;", "throw new TypeError('first line of the failure\\nsecond line, dropped');", ''].join('\n'));
      const bootstrap = writeTempModule('bootstrap', CLI_SOURCE.replace("'./auditCommand'", `'./${path.basename(throwingModule, '.ts')}'`));

      const { status, output } = runEntrypoint(bootstrap, { ...process.env, AUDIT_LOG_ERROR_DETAIL: '1' });

      expect(output).toContain('[audit] fatal error: TypeError first line of the failure');
      expect(output).not.toContain('second line, dropped');
      assertPublishableOutput(output);
      expect(status).toBe(1);
    });

    it('the REAL entrypoint, refusing to start without RANKING_IP_HASH_KEY, prints only the variable name', () => {
      const { status, output } = runEntrypoint(CLI_PATH, envWithout('RANKING_IP_HASH_KEY', 'AUDIT_LOG_ERROR_DETAIL'));

      expect(output).toContain('[audit] RANKING_IP_HASH_KEY is not set in the environment');
      expect(output).not.toMatch(/RANKING_IP_HASH_KEY\s*=/); // the name, never a value
      assertPublishableOutput(output);
      expect(status).toBe(1);
    }, 60_000);
  });
});
