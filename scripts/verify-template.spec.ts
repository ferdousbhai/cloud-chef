import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { copyCanonicalTemplateSource } from './verify-template.mjs';

describe('standalone template verification source', () => {
  test('starts from the canonical snapshot source and generates bindings before stack verification', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cloudchef-template-source-'));
    try {
      await copyCanonicalTemplateSource(tempDir, [resolve('template/package.json')]);

      expect(existsSync(join(tempDir, 'package.json'))).toBe(true);
      expect(existsSync(join(tempDir, 'package-lock.json'))).toBe(false);
      expect(existsSync(join(tempDir, 'preview-runtime'))).toBe(false);

      const pkg = JSON.parse(readFileSync(join(tempDir, 'package.json'), 'utf8')) as {
        scripts: { deploy: string; typecheck: string };
      };
      expect(pkg.scripts.typecheck).toContain('cf-typegen');
      expect(pkg.scripts.deploy.indexOf('pnpm run typecheck')).toBeLessThan(
        pkg.scripts.deploy.indexOf('pnpm run verify:stack'),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
