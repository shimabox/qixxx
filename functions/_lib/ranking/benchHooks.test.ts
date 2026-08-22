// Isolation guarantees for the CPU-harness bench hook. If any of these fail,
// a benchmark-only injection point has become reachable on the live endpoint.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBenchHooks } from './benchHooks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('resolveBenchHooks: production envs never arm it', () => {
  it('returns undefined for a realistic production env', () => {
    expect(resolveBenchHooks({ DB: {}, SHARES: {} })).toBeUndefined();
  });

  it('returns undefined for junk envs rather than throwing (never a 500 on the live path)', () => {
    for (const env of [undefined, null, 'string', 42, [], {}]) {
      expect(resolveBenchHooks(env)).toBeUndefined();
    }
  });

  it('ignores the flag on its own — a function is also required', () => {
    // The structural lock: no binding, header, query string or request body
    // can put a live JS function on `env`, so setting the flag alone (the
    // only half a remote attacker could ever influence) achieves nothing.
    expect(resolveBenchHooks({ BENCH_HOOKS: 'enabled' })).toBeUndefined();
    expect(resolveBenchHooks({ BENCH_HOOKS: 'enabled', BENCH_GAME_FACTORY: 'not-a-function' })).toBeUndefined();
    expect(resolveBenchHooks({ BENCH_HOOKS: 'enabled', BENCH_GAME_FACTORY: { call: 1 } })).toBeUndefined();
  });

  it('ignores a factory without the flag', () => {
    expect(resolveBenchHooks({ BENCH_GAME_FACTORY: () => undefined })).toBeUndefined();
    expect(resolveBenchHooks({ BENCH_HOOKS: 'true', BENCH_GAME_FACTORY: () => undefined })).toBeUndefined();
    expect(resolveBenchHooks({ BENCH_HOOKS: true, BENCH_GAME_FACTORY: () => undefined })).toBeUndefined();
  });

  it('arms only when both locks are satisfied in-process', () => {
    const factory = () => undefined;
    const hooks = resolveBenchHooks({ BENCH_HOOKS: 'enabled', BENCH_GAME_FACTORY: factory });
    expect(hooks?.gameFactory).toBe(factory);
  });
});

describe('deployment configuration never defines the bench bindings', () => {
  it('wrangler.toml declares neither BENCH_HOOKS nor BENCH_GAME_FACTORY', () => {
    const wrangler = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.toml'), 'utf8');
    expect(wrangler).not.toMatch(/BENCH_HOOKS/);
    expect(wrangler).not.toMatch(/BENCH_GAME_FACTORY/);
  });

  it('no committed .toml/.json config arms the hook', () => {
    const candidates = ['wrangler.toml', 'package.json', 'tsconfig.json', 'tsconfig.functions.json'];
    for (const file of candidates) {
      const full = path.join(REPO_ROOT, file);
      if (!fs.existsSync(full)) continue;
      expect(fs.readFileSync(full, 'utf8')).not.toMatch(/BENCH_HOOKS/);
    }
  });

  it('the only places naming the hook are its own module, its tests, the harness and the single scores.ts call site', () => {
    // Guards against the hook quietly spreading into other request paths.
    const roots = ['functions', 'src', 'docs/measurements'];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|mjs)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('BENCH_HOOKS')) {
          hits.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    for (const root of roots) {
      const full = path.join(REPO_ROOT, root);
      if (fs.existsSync(full)) walk(full);
    }
    const expected = [
      'functions/_lib/ranking/benchHooks.test.ts',
      'functions/_lib/ranking/benchHooks.ts',
    ];
    const historicalHarness = path.join(REPO_ROOT, 'docs/measurements/measure-post-cpu.ts');
    if (fs.existsSync(historicalHarness)) {
      expected.push('docs/measurements/measure-post-cpu.ts');
    }
    expect(hits.sort()).toEqual(expected.sort());
  });
});
