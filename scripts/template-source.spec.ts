import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listTemplateSourceFiles } from './template-source.mjs';

describe('template snapshot source', () => {
  test('is the committed template, and an untracked template file stops generation', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cloudchef-template-files-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: rootDir, stdio: 'pipe' });
    try {
      git('init', '--quiet');
      mkdirSync(join(rootDir, 'template', 'src'), { recursive: true });
      writeFileSync(join(rootDir, 'template', '.gitignore'), 'node_modules\n');
      writeFileSync(join(rootDir, 'template', 'src', 'application.ts'), 'export {};\n');
      git('add', 'template');
      mkdirSync(join(rootDir, 'template', 'node_modules'));
      writeFileSync(join(rootDir, 'template', 'node_modules', 'ignored.js'), '');

      expect(listTemplateSourceFiles(rootDir)).toEqual([
        join(rootDir, 'template', '.gitignore'),
        join(rootDir, 'template', 'src', 'application.ts'),
      ]);

      writeFileSync(join(rootDir, 'template', 'notes.txt'), 'a local scratch file\n');
      expect(() => listTemplateSourceFiles(rootDir)).toThrow(
        'Untracked files under template/ would be seeded into every workspace: template/notes.txt.',
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
