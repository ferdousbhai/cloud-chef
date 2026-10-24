import { describe, expect, it } from 'vitest';
import { parseDependencyCommand } from './dependency-command.js';

describe('dependency command', () => {
  it('stages any number of registry packages, whichever they are', () => {
    expect(parseDependencyCommand('pnpm add date-fns chart.js@^4.0.0 @radix-ui/react-dialog openai')).toEqual({
      mode: 'add',
      packages: ['date-fns', 'chart.js@^4.0.0', '@radix-ui/react-dialog', 'openai'],
    });
    const many = Array.from({ length: 60 }, (_, index) => `p${index}`);
    expect(parseDependencyCommand(`pnpm add ${many.join(' ')}`)?.packages).toEqual(many);
  });

  it('allows registry aliases', () => {
    expect(parseDependencyCommand('pnpm add date-tools@npm:date-fns@^4.0.0')?.packages).toEqual([
      'date-tools@npm:date-fns@^4.0.0',
    ]);
  });

  it('rejects non-registry package sources before a package manager sees them', () => {
    for (const spec of [
      'https://example.com/package.tgz',
      'git+https://github.com/example/package.git',
      'github:example/package',
      'file:../package',
      'link:../package',
      'workspace:*',
      './local-package',
    ]) {
      expect(() => parseDependencyCommand(`pnpm add ${spec}`), spec).toThrow('Only npm registry');
      expect(() => parseDependencyCommand(`npm install ${spec}`), spec).toThrow('Only npm registry');
    }
  });

  it('syncs the lockfile, and leaves every other command to run as asked', () => {
    expect(parseDependencyCommand('pnpm install --lockfile-only')).toEqual({ mode: 'sync-lockfile', packages: [] });
    expect(parseDependencyCommand('pnpm test')).toBeNull();
    expect(parseDependencyCommand('pnpm install')).toBeNull();
    expect(parseDependencyCommand('pnpm remove date-fns')).toBeNull();
    expect(parseDependencyCommand('npm install -D date-fns && pnpm test')).toBeNull();
  });
});
