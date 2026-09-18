import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dependencyNames,
  findForbiddenFiles,
  findForbiddenLegacyPaths,
  findForbiddenDependencies,
  findForbiddenImports,
  findForbiddenRuntimeEnvAccess,
  findForbiddenRootBrowserRuntimeDependencies,
  findInternalPackageMetadataErrors,
  findCloudflareAiPeerCompatibilityErrors,
  findDeploymentRuntimePolicyErrors,
  findMissingDependencies,
  findMissingCommandSteps,
  findPackageVersionAlignmentErrors,
  findRootWorkspacePolicyErrors,
  findRuntimePinErrors,
  findSandboxRuntimePinErrors,
  findRootMigrationErrors,
  findBuilderTemplateModuleErrors,
  packageDependencyVersion,
} from './verify-stack-alignment.mjs';

describe('stack alignment verification helpers', () => {
  it('accepts the reviewed root-only blocked dependency scripts', () => {
    const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');

    expect(findRootWorkspacePolicyErrors(workspace)).toEqual([]);
    expect(findRootWorkspacePolicyErrors(workspace.replace('  protobufjs: false\n', ''))).toContain(
      'pnpm-workspace.yaml must explicitly block protobufjs exactly once.',
    );
  });

  it('checks runtime artifact pins before merge without mutating pull request issues', () => {
    const workflow = readFileSync(new URL('../.github/workflows/runtime-artifacts.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('user-workspace-runtime/src/container-toolchain.ts');
    expect(workflow).toContain("if: always() && github.event_name != 'pull_request'");
    expect(workflow).toContain('.author.login == \\"github-actions[bot]\\"');
    expect(workflow).toContain('.author.login == \\"$REPOSITORY_OWNER\\"');
  });

  it('keeps Computer object probes below the Durable Object SQL variable limit', () => {
    const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
    const patch = readFileSync(new URL('../patches/@cloudflare__computer@0.2.1.patch', import.meta.url), 'utf8');
    const installed = readFileSync(
      new URL('../node_modules/@cloudflare/computer/dist/index.js', import.meta.url),
      'utf8',
    );

    expect(workspace).toContain("'@cloudflare/computer@0.2.1': patches/@cloudflare__computer@0.2.1.patch");
    expect(patch).toContain('-const PROBE_BATCH = 100;');
    expect(patch).toContain('+const PROBE_BATCH = 64;');
    expect(installed).toContain('const PROBE_BATCH = 64;');
  });

  it('collects dependency names across package sections', () => {
    expect(
      dependencyNames({
        dependencies: { '@tanstack/react-start': '^1.0.0' },
        devDependencies: { wrangler: '^4.0.0' },
      }),
    ).toEqual(new Set(['@tanstack/react-start', 'wrangler']));
  });

  it('rejects Convex, Remix, and non-Workers-AI model providers', () => {
    const errors = findForbiddenDependencies(
      {
        dependencies: {
          convex: '^1.0.0',
          '@remix-run/react': '^2.0.0',
          '@ai-sdk/openai': '^4.0.0',
          '@ai-sdk/amazon-bedrock': '^3.0.0',
        },
        devDependencies: {
          '@types/diff': '^8.0.0',
        },
      },
      'package.json',
    );

    expect(errors).toHaveLength(5);
  });

  it('reports missing required stack dependencies', () => {
    expect(
      findMissingDependencies({ dependencies: { agents: '^1.0.0' } }, 'package.json', ['agents', 'wrangler']),
    ).toEqual(['package.json must include wrangler for the TanStack Start + Cloudflare stack.']);
  });

  it('requires aligned Cloudflare/TanStack package versions and compatible AI peers', () => {
    const pkg = {
      dependencies: {
        '@cloudflare/ai-chat': '^0.9.1',
        '@ai-sdk/provider': '4.0.4',
        '@tanstack/react-start': '^1.168.26',
        agents: '^0.17.1',
        ai: '7.0.48',
        'workers-ai-provider': '4.0.0',
        zod: '^4.4.3',
      },
      devDependencies: {
        '@ai-sdk/react': '4.0.51',
        wrangler: '^4.105.0',
      },
    };

    expect(packageDependencyVersion(pkg, '@ai-sdk/react')).toBe('4.0.51');
    expect(findCloudflareAiPeerCompatibilityErrors(pkg, 'package.json')).toEqual([]);
    expect(findPackageVersionAlignmentErrors(pkg, pkg, 'template/package.json', ['ai', 'zod'])).toEqual([]);
    expect(
      findPackageVersionAlignmentErrors(pkg, { dependencies: { ai: '7.0.49' } }, 'template/package.json', ['ai']),
    ).toEqual(['template/package.json must align ai with package.json 7.0.48; found 7.0.49.']);
  });

  it('keeps AI SDK packages on the current Cloudflare-compatible peer line', () => {
    expect(
      findCloudflareAiPeerCompatibilityErrors(
        {
          dependencies: {
            '@ai-sdk/provider': '4.0.0',
            '@ai-sdk/react': '4.0.7',
            '@cloudflare/ai-chat': '^0.9.1',
            agents: '^0.17.1',
            ai: '7.0.6',
            'workers-ai-provider': '^3.3.0',
          },
        },
        'package.json',
      ),
    ).toEqual([
      'package.json must pin the tested AI SDK 7 family ai@7.0.48 for agents, @cloudflare/ai-chat; found 7.0.6.',
      'package.json must pin the tested AI SDK 7 family @ai-sdk/react@4.0.51 for agents, @cloudflare/ai-chat; found 4.0.7.',
    ]);
  });

  it('keeps the official Sandbox package and container image aligned', () => {
    const version = '0.12.4';
    const image = `docker.io/cloudflare/sandbox:${version}@sha256:${'a'.repeat(64)}`;

    expect(findSandboxRuntimePinErrors(version, version, image)).toEqual([]);
    expect(findSandboxRuntimePinErrors('^0.12.4', version, image)).toEqual([
      'package.json must pin the installed Cloudflare Sandbox version 0.12.4 exactly.',
    ]);
    expect(findSandboxRuntimePinErrors(version, version, image.replace(version, '0.12.3'))).toEqual([
      'Cloudflare Sandbox package 0.12.4 must match container image tag 0.12.3.',
    ]);
  });

  it('reports forbidden generated lockfiles', () => {
    expect(findForbiddenFiles(['scripts/fixtures/forbidden-stack-imports.txt'])).toEqual([
      'scripts/fixtures/forbidden-stack-imports.txt must not exist; CloudChef uses pnpm lockfiles only.',
    ]);
  });

  it('reports forbidden legacy stack paths', () => {
    expect(findForbiddenLegacyPaths(['scripts/fixtures/forbidden-stack-imports.txt'])).toEqual([
      'scripts/fixtures/forbidden-stack-imports.txt must not exist; CloudChef uses TanStack Start and Cloudflare-only providers.',
    ]);
  });

  it('requires the production Node and pnpm toolchain pins', () => {
    expect(
      findRuntimePinErrors(
        {
          engines: { node: '>=26.0.0' },
          packageManager: 'pnpm@11.14.0',
          devDependencies: { '@types/node': '^26.1.0' },
        },
        'package.json',
      ),
    ).toEqual([]);

    expect(findRuntimePinErrors({ devDependencies: {} }, 'package.json')).toEqual([
      'package.json must set engines.node to >=26.0.0.',
      'package.json must pin packageManager to pnpm@11.14.0.',
      'package.json must use @types/node ^26.x for the Node 26 toolchain.',
    ]);
  });

  it('prevents accidental publication of internal workspace packages', () => {
    expect(findInternalPackageMetadataErrors({ private: true }, 'cloudchef-agent/package.json')).toEqual([]);
    expect(findInternalPackageMetadataErrors({}, 'cloudchef-agent/package.json')).toEqual([
      'cloudchef-agent/package.json must set private to true so it cannot be published accidentally.',
    ]);
  });

  it('keeps deployment admission aligned with the generated template compatibility date', () => {
    const runtimePolicy = "export const DEPLOYMENT_COMPATIBILITY_DATE = '2026-07-21';";
    const templateConfig = '{ "compatibility_date": "2026-07-21", }';

    expect(findDeploymentRuntimePolicyErrors(templateConfig, runtimePolicy)).toEqual([]);
    expect(findDeploymentRuntimePolicyErrors('{ "compatibility_date": "2026-07-22" }', runtimePolicy)).toEqual([
      'deployment compatibility date "2026-07-21" must match template/wrangler.jsonc "2026-07-22".',
    ]);
    expect(findDeploymentRuntimePolicyErrors(templateConfig, 'export const other = 1;')).toEqual([
      'deployment runtime policy must declare DEPLOYMENT_COMPATIBILITY_DATE.',
    ]);
    expect(findDeploymentRuntimePolicyErrors('{}', runtimePolicy)).toEqual([
      'template/wrangler.jsonc must declare compatibility_date.',
    ]);
  });

  it('keeps only control-plane tables in root D1', () => {
    const requiredTables = [
      'user',
      'cloudflare_auth_sessions',
      'cloudflare_oauth_states',
      'cloudflare_credentials',
      'cloudflare_connections',
      'user_computer_runtimes',
    ]
      .map((table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT);`)
      .join('\n');
    expect(findRootMigrationErrors(requiredTables)).toEqual([]);
    expect(
      findRootMigrationErrors(
        `${requiredTables}
         CREATE TABLE chats (id TEXT);`,
      ),
    ).toContain('root migrations must not create the user-owned chats workload table.');
  });

  it('requires the server Builder template to match the current template source', () => {
    expect(
      findBuilderTemplateModuleErrors("export const BUILDER_TEMPLATE_SOURCE_SHA256 = 'source-hash';", 'source-hash'),
    ).toEqual([]);
    expect(findBuilderTemplateModuleErrors('', 'source-hash')).toEqual([
      'app/agents/builder-template.generated.ts is stale; run pnpm run generate:artifacts.',
    ]);
  });

  it('rejects reintroducing a browser execution runtime into the root application', () => {
    expect(
      findForbiddenRootBrowserRuntimeDependencies({
        dependencies: { '@webcontainer/api': '1.6.4' },
        devDependencies: { '@xterm/xterm': '5.5.0' },
      }),
    ).toEqual([
      'package.json must not depend on the removed browser execution runtime @webcontainer/api.',
      'package.json must not depend on the removed browser execution runtime @xterm/xterm.',
    ]);
  });

  it('rejects forbidden framework and provider imports', () => {
    const errors = findForbiddenImports([new URL('./fixtures/forbidden-stack-imports.txt', import.meta.url).pathname]);

    expect(errors).toHaveLength(4);
  });

  it('rejects runtime env access outside explicit SSR-only allowlists', () => {
    const fixture = new URL('./fixtures/forbidden-runtime-env-access.ts', import.meta.url).pathname;

    expect(findForbiddenRuntimeEnvAccess([fixture])).toEqual([
      `${fixture}:1 must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
      `${fixture}:2 must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
    ]);
  });

  it('allows an explicitly reviewed runtime env access without allowing other import.meta.env usage', () => {
    const fixture = new URL('./fixtures/forbidden-runtime-env-access.ts', import.meta.url).pathname;

    expect(
      findForbiddenRuntimeEnvAccess(
        [fixture],
        [
          {
            pathSuffix: 'fixtures/forbidden-runtime-env-access.ts',
            snippet: 'import.meta.env.VITE_OPENAI_API_KEY',
          },
        ],
      ),
    ).toEqual([
      `${fixture}:1 must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
    ]);
  });

  it('validates command contracts without coupling to one exact command string', () => {
    expect(
      findMissingCommandSteps('pnpm run verify:stack && pnpm run typecheck && pnpm run build', 'scripts.validate', [
        'verify:stack',
        'typecheck',
        'build',
      ]),
    ).toEqual([]);
    expect(findMissingCommandSteps('pnpm run build', 'scripts.validate', ['typecheck', 'build'])).toEqual([
      'scripts.validate must run "typecheck" in order.',
    ]);
  });
});
