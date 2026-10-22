import { describe, expect, it } from 'vitest';
import { parseDependencyCommand } from './dependency-command.js';
import { packageNameFromInstallSpec } from '../utils/stackPolicy.js';

describe('dependency command', () => {
  it('accepts ordinary package specs', () => {
    expect(
      parseDependencyCommand('pnpm add date-fns chart.js@^4.0.0 @radix-ui/react-dialog @ai-sdk/provider @ai-sdk/react'),
    ).toEqual({
      mode: 'add',
      packages: ['date-fns', 'chart.js@^4.0.0', '@radix-ui/react-dialog', '@ai-sdk/provider', '@ai-sdk/react'],
    });
  });

  it('normalizes package names from versioned and aliased specs', () => {
    expect(packageNameFromInstallSpec('openai@latest')).toBe('openai');
    expect(packageNameFromInstallSpec('@radix-ui/react-dialog')).toBe('@radix-ui/react-dialog');
    expect(packageNameFromInstallSpec('@ai-sdk/openai@4.0.0')).toBe('@ai-sdk/openai');
    expect(packageNameFromInstallSpec('model-sdk@npm:@anthropic-ai/sdk@latest')).toBe('@anthropic-ai/sdk');
  });

  it('rejects forbidden provider and framework packages, aliased or not', () => {
    expect(() =>
      parseDependencyCommand('pnpm add lucide-react convex @remix-run/react@latest model-sdk@npm:@anthropic-ai/sdk'),
    ).toThrow('Unsupported package(s): convex, @remix-run/react@latest, model-sdk@npm:@anthropic-ai/sdk');
  });

  it('rejects pnpm flags in package install requests', () => {
    expect(() => parseDependencyCommand('pnpm add -D date-fns')).toThrow(
      'Only npm registry package names and versions are allowed: -D.',
    );
  });

  it('rejects non-registry package sources before pnpm sees them', () => {
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
    }
  });

  it('allows registry aliases while retaining provider policy', () => {
    expect(parseDependencyCommand('pnpm add date-tools@npm:date-fns@^4.0.0')?.packages).toEqual([
      'date-tools@npm:date-fns@^4.0.0',
    ]);
  });

  it('requires at least one package and at most fifty', () => {
    expect(() => parseDependencyCommand('pnpm add   ')).toThrow();
    expect(() =>
      parseDependencyCommand(`pnpm add ${Array.from({ length: 51 }, (_, index) => `p${index}`).join(' ')}`),
    ).toThrow('Install at most 50 packages');
  });

  it('parses only the dependency command subset exposed through exec', () => {
    expect(parseDependencyCommand('pnpm add date-fns chart.js@^4')).toEqual({
      mode: 'add',
      packages: ['date-fns', 'chart.js@^4'],
    });
    expect(parseDependencyCommand('pnpm install --lockfile-only')).toEqual({
      mode: 'sync-lockfile',
      packages: [],
    });
    expect(parseDependencyCommand('pnpm test')).toBeNull();
    expect(() => parseDependencyCommand('pnpm install')).toThrow('exec accepts only');
    expect(() => parseDependencyCommand('npm install date-fns')).toThrow('exec accepts only');
    expect(() => parseDependencyCommand('yarn add date-fns')).toThrow('exec accepts only');
    expect(() => parseDependencyCommand('pnpm add date-fns && touch owned')).toThrow('Only npm registry');
  });
});
