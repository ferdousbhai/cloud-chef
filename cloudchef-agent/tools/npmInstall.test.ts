import { describe, expect, it } from 'vitest';
import {
  findForbiddenNpmInstallPackages,
  npmInstallToolParameters,
  parseNpmInstallCommand,
  splitPackageSpecs,
} from './npmInstall.js';
import { packageNameFromInstallSpec } from '../utils/stackPolicy.js';

describe('dependency command parameters', () => {
  it('accepts ordinary package specs', () => {
    expect(
      npmInstallToolParameters.parse({
        packages: 'date-fns chart.js@^4.0.0 @radix-ui/react-dialog @ai-sdk/provider @ai-sdk/react',
      }),
    ).toEqual({
      packages: 'date-fns chart.js@^4.0.0 @radix-ui/react-dialog @ai-sdk/provider @ai-sdk/react',
    });
  });

  it('normalizes package names from versioned and aliased specs', () => {
    expect(packageNameFromInstallSpec('openai@latest')).toBe('openai');
    expect(packageNameFromInstallSpec('@radix-ui/react-dialog')).toBe('@radix-ui/react-dialog');
    expect(packageNameFromInstallSpec('@ai-sdk/openai@4.0.0')).toBe('@ai-sdk/openai');
    expect(packageNameFromInstallSpec('model-sdk@npm:@anthropic-ai/sdk@latest')).toBe('@anthropic-ai/sdk');
  });

  it('finds forbidden provider and framework packages', () => {
    expect(
      findForbiddenNpmInstallPackages('convex @remix-run/react@latest @ai-sdk/openai model-sdk@npm:@anthropic-ai/sdk'),
    ).toEqual([
      { spec: 'convex', packageName: 'convex' },
      { spec: '@remix-run/react@latest', packageName: '@remix-run/react' },
      { spec: '@ai-sdk/openai', packageName: '@ai-sdk/openai' },
      { spec: 'model-sdk@npm:@anthropic-ai/sdk', packageName: '@anthropic-ai/sdk' },
    ]);
  });

  it('rejects unsupported package installs', () => {
    const parsed = npmInstallToolParameters.safeParse({
      packages: 'lucide-react openai @ai-sdk/groq@latest @ai-sdk/amazon-bedrock @google/genai',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(
      'Unsupported package(s): openai, @ai-sdk/groq@latest, @ai-sdk/amazon-bedrock, @google/genai',
    );
  });

  it('rejects pnpm flags in package install requests', () => {
    const parsed = npmInstallToolParameters.safeParse({ packages: '-D date-fns' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('pnpm flags are not allowed in dependency package specs: -D');
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
      const parsed = npmInstallToolParameters.safeParse({ packages: spec });
      expect(parsed.success, spec).toBe(false);
      expect(parsed.error?.issues.some((issue) => issue.message.includes('Only npm registry'))).toBe(true);
    }
  });

  it('allows registry aliases while retaining provider policy', () => {
    expect(npmInstallToolParameters.safeParse({ packages: 'date-tools@npm:date-fns@^4.0.0' }).success).toBe(true);
  });

  it('allows the agent to synchronize a lockfile without accepting arbitrary pnpm flags', () => {
    expect(npmInstallToolParameters.parse({ mode: 'sync-lockfile' })).toEqual({ mode: 'sync-lockfile' });
    expect(npmInstallToolParameters.safeParse({ mode: 'sync-lockfile', packages: 'date-fns' }).success).toBe(false);
    expect(npmInstallToolParameters.safeParse({ mode: 'add' }).success).toBe(false);
  });

  it('parses only the dependency command subset exposed through exec', () => {
    expect(parseNpmInstallCommand('pnpm add date-fns chart.js@^4')).toEqual({
      mode: 'add',
      packages: ['date-fns', 'chart.js@^4'],
    });
    expect(parseNpmInstallCommand('pnpm install --lockfile-only')).toEqual({
      mode: 'sync-lockfile',
      packages: [],
    });
    expect(parseNpmInstallCommand('pnpm test')).toBeNull();
    expect(() => parseNpmInstallCommand('pnpm install')).toThrow('exec accepts only');
    expect(() => parseNpmInstallCommand('npm install date-fns')).toThrow('exec accepts only');
    expect(() => parseNpmInstallCommand('yarn add date-fns')).toThrow('exec accepts only');
    expect(() => parseNpmInstallCommand('pnpm add date-fns && touch owned')).toThrow('Only npm registry');
  });

  it('splits package specs by whitespace', () => {
    expect(splitPackageSpecs('  clsx\nlucide-react\tdate-fns  ')).toEqual(['clsx', 'lucide-react', 'date-fns']);
  });
});
