import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG_PATH, resolveDefaultConfigPath } from './d1Adapter';

describe('LocalPlatformProxyD1Adapter default config path', () => {
  it('decodes spaces and non-ASCII characters in the source file URL', () => {
    const configPath = resolveDefaultConfigPath(
      'file:///tmp/my%20repo/%E6%97%A5%E6%9C%AC%E8%AA%9E/scripts/audit/d1Adapter.ts'
    );

    expect(configPath).toContain('my repo');
    expect(configPath).toContain('日本語');
    expect(configPath).not.toContain('%20');
    expect(path.basename(configPath)).toBe('wrangler.toml');
  });

  it.skipIf(process.platform !== 'win32')('removes the leading slash from a Windows drive path', () => {
    expect(
      resolveDefaultConfigPath('file:///C:/my%20repo/scripts/audit/d1Adapter.ts')
    ).toBe('C:\\my repo\\wrangler.toml');
  });

  it('is a decoded filesystem path to the repository wrangler.toml', () => {
    expect(DEFAULT_CONFIG_PATH).not.toContain('%20');
    expect(path.basename(DEFAULT_CONFIG_PATH)).toBe('wrangler.toml');
    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(true);
  });
});
