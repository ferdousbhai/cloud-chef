import { describe, expect, it } from 'vitest';
import { findWorkersBuildsConfigErrors } from './workers-builds-config.mjs';

const validConfig = {
  worker: 'cloudchef',
  repository: 'ferdousbhai/cloud-chef',
  productionBranch: 'main',
  rootDirectory: '/',
  buildCommand: 'pnpm run workers-builds:build',
  deployCommand: 'pnpm run workers-builds:deploy',
  nonProductionBuilds: false,
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
      'pnpm install --frozen-lockfile && node scripts/check-workers-builds-environment.mjs && pnpm run generate && node scripts/deploy-production.mjs --check-workers-builds',
    'workers-builds:deploy': 'node scripts/deploy-production.mjs --workers-builds',
    'build:check': 'vite build',
    'release:build':
      'pnpm run build:check && pnpm run verify:built-ssr && pnpm run verify:static-assets && pnpm run bundle:check',
    validate: 'node scripts/validate.mjs',
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
        workerConfig: { preview_urls: false },
      }),
    ).toEqual([]);
  });

  it('rejects branch builds, preview URLs, mutable toolchains, unreviewed variables, and GitHub deployment workflows', () => {
    expect(
      findWorkersBuildsConfigErrors({
        config: {
          ...validConfig,
          nonProductionBuilds: true,
          buildTokenName: 'per-project-token',
          buildVariables: { ...validConfig.buildVariables, UNREVIEWED_SECRET: 'value' },
        },
        packageJson: {
          packageManager: 'pnpm@latest',
          scripts: {
            ...packageJson.scripts,
            'build:check': 'vite build --mode development',
            validate: undefined,
          },
        },
        nvmrc: 'node\n',
        githubWorkflowPaths: [
          '.github/workflows/runtime-artifacts.yml',
          '.github/workflows/ci.yml',
          '.github/workflows/deploy.yml',
        ],
        browserGateWorkflow: undefined,
        workerConfig: {
          preview_urls: true,
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        '.github/workflows/browser-gate.yml must run pnpm run verify:built-browser; the Workers Builds image cannot host the browser gate.',
        'workers-builds.production.json nonProductionBuilds must be false; found true.',
        'cloudflare.config.ts previewUrls must be false; found true.',
        'workers-builds.production.json buildTokenName must be "account-workers-builds-production"; found "per-project-token".',
        'workers-builds.production.json buildVariables must not contain unreviewed variables: UNREVIEWED_SECRET.',
        'package.json packageManager must pin an exact pnpm version; found "pnpm@latest".',
        // The deploy step ships the Worker `release:build` builds, so its build must be exactly the release.
        'package.json scripts.build:check must be "vite build"; found "vite build --mode development".',
        'package.json scripts.validate must be "node scripts/validate.mjs"; found undefined.',
        '.nvmrc must pin an exact Node.js version; found "node".',
        'GitHub deployment workflows must not exist; Cloudflare Workers Builds is the only CI/CD provider. Found: .github/workflows/ci.yml, .github/workflows/deploy.yml.',
      ]),
    );
  });

  it('requires the build image toolchain to match .nvmrc and packageManager', () => {
    expect(
      findWorkersBuildsConfigErrors({
        config: validConfig,
        packageJson: { ...packageJson, packageManager: 'pnpm@11.15.0' },
        nvmrc: '26.4.0\n',
        githubWorkflowPaths: ['.github/workflows/browser-gate.yml'],
        browserGateWorkflow: '      - run: pnpm run verify:built-browser\n',
        workerConfig: { preview_urls: false },
      }),
    ).toEqual([
      'workers-builds.production.json buildVariables.NODE_VERSION must be "26.4.0"; found "26.3.0".',
      'workers-builds.production.json buildVariables.PNPM_VERSION must be "11.15.0"; found "11.14.0".',
    ]);
  });
});
