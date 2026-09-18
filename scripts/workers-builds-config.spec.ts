import { describe, expect, it } from 'vitest';
import { findWorkersBuildsConfigErrors } from './workers-builds-config.mjs';

const validConfig = {
  worker: 'cloudchef',
  repository: 'ferdousbhai/cloud-chef',
  productionBranch: 'main',
  rootDirectory: '/',
  buildCommand: 'pnpm run workers-builds:build',
  deployCommand: 'pnpm run workers-builds:deploy',
  nonProductionBuilds: true,
  nonProductionDeployCommand: 'pnpm run workers-builds:preview',
  pathIncludes: ['*'],
  pathExcludes: [],
  buildCaching: true,
  buildTokenName: 'account-workers-builds-production',
  buildVariables: {
    NODE_VERSION: '26.3.0',
    PNPM_VERSION: '11.14.0',
    SKIP_DEPENDENCY_INSTALL: '1',
  },
  requiredBuildVariables: ['CLOUDFLARE_OAUTH_CLIENT_ID'],
};

const packageJson = {
  packageManager: 'pnpm@11.14.0',
  scripts: {
    'workers-builds:build':
      'pnpm install --frozen-lockfile && node scripts/check-workers-builds-environment.mjs && pnpm run validate && node scripts/deploy-production.mjs --check-workers-builds',
    'workers-builds:deploy':
      'node scripts/deploy-production.mjs --check-workers-builds && pnpm run provision:production:check && pnpm run verify:production-config && pnpm run verify:workers-builds-config && pnpm run d1:bookmark:production && pnpm run d1:migrations:apply:production && node scripts/deploy-production.mjs',
    'workers-builds:preview': 'node scripts/upload-workers-builds-preview.mjs',
  },
};

describe('Workers Builds production configuration', () => {
  it('accepts the reviewed production trigger contract', () => {
    expect(
      findWorkersBuildsConfigErrors({
        config: validConfig,
        packageJson,
        nvmrc: '26.3.0\n',
        githubWorkflowPaths: ['.github/workflows/browser-gate.yml', '.github/workflows/runtime-artifacts.yml'],
        browserGateWorkflow: '      - run: pnpm run verify:built-browser\n',
        githubCompositeActionExists: false,
        workerConfig: {},
      }),
    ).toEqual([]);
  });

  it('rejects disabled previews, mutable toolchains, unreviewed variables, and GitHub deployment workflows', () => {
    expect(
      findWorkersBuildsConfigErrors({
        config: {
          ...validConfig,
          nonProductionBuilds: false,
          nonProductionDeployCommand: 'wrangler deploy',
          buildTokenName: 'per-project-token',
          containerImage: { reference: 'forbidden' },
          buildVariables: { ...validConfig.buildVariables, UNREVIEWED_SECRET: 'value' },
        },
        packageJson: { ...packageJson, packageManager: 'pnpm@latest' },
        nvmrc: 'node\n',
        githubWorkflowPaths: [
          '.github/workflows/runtime-artifacts.yml',
          '.github/workflows/ci.yml',
          '.github/workflows/deploy.yml',
        ],
        browserGateWorkflow: undefined,
        githubCompositeActionExists: true,
        workerConfig: { containers: [{ class_name: 'DeploymentSandbox', image: './Dockerfile.sandbox' }] },
      }),
    ).toEqual(
      expect.arrayContaining([
        '.github/workflows/browser-gate.yml must run pnpm run verify:built-browser; the Workers Builds image cannot host the browser gate.',
        'workers-builds.production.json nonProductionBuilds must be true; found false.',
        'workers-builds.production.json nonProductionDeployCommand must be "pnpm run workers-builds:preview"; found "wrangler deploy".',
        'workers-builds.production.json buildTokenName must be "account-workers-builds-production"; found "per-project-token".',
        'workers-builds.production.json buildVariables must not contain unreviewed variables: UNREVIEWED_SECRET.',
        'workers-builds.production.json must not build a CloudChef-owned Sandbox image.',
        'wrangler.jsonc must not bind CloudChef-owned Containers.',
        'package.json packageManager must be "pnpm@11.14.0"; found "pnpm@latest".',
        '.nvmrc must be "26.3.0"; found "node".',
        'GitHub deployment workflows must not exist; Cloudflare Workers Builds is the only CI/CD provider. Found: .github/workflows/ci.yml, .github/workflows/deploy.yml.',
        '.github/actions/setup-and-build/action.yaml must not exist; the Cloudflare build command owns toolchain setup.',
      ]),
    );
  });
});
