import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG_PATH } from './d1Adapter';

describe('LocalPlatformProxyD1Adapter default config path', () => {
  it('is a decoded filesystem path to the repository wrangler.toml', () => {
    expect(DEFAULT_CONFIG_PATH).not.toContain('%20');
    expect(path.basename(DEFAULT_CONFIG_PATH)).toBe('wrangler.toml');
    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(true);
  });
});
