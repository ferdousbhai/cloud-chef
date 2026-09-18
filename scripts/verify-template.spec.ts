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
      expect(existsSync(join(tempDir, 'worker-configuration.d.ts'))).toBe(false);

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

  test('uses one canonical Cloudflare Vite build with no container preview entrypoint', () => {
    const viteConfig = readFileSync('template/vite.config.ts', 'utf8');
    const server = readFileSync('template/src/server.ts', 'utf8');
    const plainServer = readFileSync('template/src/plain-server.ts', 'utf8');
    const pkg = JSON.parse(readFileSync('template/package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(server).toContain('handler.fetch(request)');
    expect(server).toContain('routeAppAgentRequest');
    expect(plainServer).toContain('handler.fetch(request)');
    expect(server).not.toContain('CLOUDCHEF_ISOLATED_PREVIEW');
    expect(server).not.toContain('isAgentRoute');
    expect(viteConfig).toContain('cloudflare({ viteEnvironment: { name: "ssr" } })');
    expect(viteConfig).toContain('tanstackStart()');
    expect(existsSync('template/src/preview-server.ts')).toBe(false);
    expect(existsSync('template/wrangler.preview.jsonc')).toBe(false);
    expect(pkg.scripts).not.toHaveProperty('build:isolated-preview');
    expect(pkg.scripts.dev).toBe('vite dev --host 0.0.0.0');
    expect(pkg.scripts.preview).toBe('vite preview --host 0.0.0.0');
    expect(existsSync('template/vite.preview.config.mjs')).toBe(false);
    expect(existsSync('template/src/preview')).toBe(false);
    expect(existsSync('template/index.html')).toBe(false);
  });
});
