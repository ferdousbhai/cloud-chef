import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { verifyCommittedCloudflareConfig } from './verify-template.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the committed template Cloudflare configuration', () => {
  test('is what its project renders', () => {
    expect(() => verifyCommittedCloudflareConfig('template')).not.toThrow();
  });

  test('fails verification once it drifts from its project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudchef-template-config-'));
    tempDirs.push(dir);
    copyFileSync('template/cloudflare.project.json', join(dir, 'cloudflare.project.json'));
    const config = readFileSync('template/cloudflare.config.ts', 'utf8');
    writeFileSync(join(dir, 'cloudflare.config.ts'), config.replace(/^ *ASSETS: .*\n/m, ''));

    expect(() => verifyCommittedCloudflareConfig(dir)).toThrow(/not what its project renders/);
  });
});
