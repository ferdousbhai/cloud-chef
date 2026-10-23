import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { copyCanonicalTemplateSource, requireFailure } from './verify-template.mjs';

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

// The probe spawns pnpm three times, which can take seconds on a loaded CI builder.
describe('negative template checks', { timeout: 30_000 }, () => {
  test('pass only when the command fails for the reason they probe', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cloudchef-require-failure-'));
    try {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'require-failure-probe',
          private: true,
          scripts: {
            policy:
              'node -e "console.error(\'Production module x uses forbidden dynamic-import capability\'); process.exit(1)"',
            unrelated: 'node -e "console.error(\'Cannot find module vite\'); process.exit(1)"',
            passes: 'node -e "process.exit(0)"',
          },
        }),
      );
      const reason = 'uses forbidden dynamic-import capability';

      expect(() => requireFailure(tempDir, ['run', 'policy'], reason)).not.toThrow();
      expect(() => requireFailure(tempDir, ['run', 'unrelated'], reason)).toThrow(/failed without reporting/);
      expect(() => requireFailure(tempDir, ['run', 'passes'], reason)).toThrow(/unexpectedly succeeded/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
