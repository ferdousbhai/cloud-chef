import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function listTemplateSourceFiles(rootDir) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'template'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
  } catch (error) {
    // Managed build sandboxes can allow the parent generator while denying its nested Git
    // subprocess. The template ignore surface is deliberately small, so walk the canonical source
    // tree in that environment instead of making artifact generation impossible.
    if (error?.code !== 'EPERM') {
      throw error;
    }
    return listTemplateSourceFilesWithoutGit(rootDir);
  }

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((path) => resolve(rootDir, path))
    .filter(existsSync)
    .sort((left, right) => left.localeCompare(right));
}

function listTemplateSourceFilesWithoutGit(rootDir) {
  const templateDir = resolve(rootDir, 'template');
  const files = [];
  const ignoredDirectories = new Set([
    'node_modules',
    'dist',
    'dist-ssr',
    '.output',
    '.tanstack',
    '.wrangler',
    '.cloudflare',
    '.idea',
    '.vscode',
  ]);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          walk(path);
        }
        continue;
      }
      if (
        !entry.isFile() ||
        entry.name === '.DS_Store' ||
        entry.name.startsWith('.env') ||
        entry.name.startsWith('.dev.vars') ||
        /(?:\.log|\.local|\.suo|\.ntvs|\.njsproj|\.sln|\.sw.)$/.test(entry.name)
      ) {
        continue;
      }
      files.push(path);
    }
  };
  walk(templateDir);
  return files.sort((left, right) => left.localeCompare(right));
}

export function templateSourceDigest(rootDir, files = listTemplateSourceFiles(rootDir)) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(resolve(rootDir, 'template'), file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
