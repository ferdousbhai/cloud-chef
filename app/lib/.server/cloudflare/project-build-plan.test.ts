import { describe, expect, it } from 'vitest';
import { deployApiDecision } from './deploy-api-policy';
import { buildPlan, deployWorkerName, withoutJsonComments } from './project-build-plan';

const PACKAGE = JSON.stringify({ scripts: { build: 'vite build' } });

describe("an uploaded project's build plan", () => {
  it('reads a Wrangler config with comments, the lockfile, and the D1 migrations to apply', () => {
    const plan = buildPlan({
      'package.json': PACKAGE,
      'package-lock.json': '{}',
      'wrangler.jsonc': `{
        // The site.
        "name": "glossary",
        "main": "@tanstack/react-start/server-entry", /* the entry */
        "d1_databases": [{ "binding": "DB", "database_name": "glossary-db", "migrations_dir": "migrations" },],
      }`,
    });
    expect(plan).toEqual({
      deployable: true,
      packageManager: 'npm',
      install: 'npm ci',
      build: 'npm run build',
      configBuild: null,
      configFile: 'wrangler.jsonc',
      workerName: 'glossary',
      migrations: [{ binding: 'DB', databaseName: 'glossary-db' }],
    });
  });

  it('reads wrangler.toml and its build command, and installs with the package manager the project names', () => {
    const plan = buildPlan({
      'package.json': JSON.stringify({ packageManager: 'pnpm@10.27.0' }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'wrangler.toml': 'name = "shop"\n[build]\ncommand = "node build.mjs"\n',
    });
    expect(plan).toMatchObject({
      packageManager: 'pnpm',
      install: 'pnpm install --frozen-lockfile',
      build: null,
      configBuild: 'node build.mjs',
    });
    expect(buildPlan({ 'package.json': '{}', 'wrangler.json': '{"name":"x"}' })).toMatchObject({
      install: 'npm install',
    });
    expect(
      buildPlan({ 'package.json': '{}', 'yarn.lock': '', '.yarnrc.yml': '', 'wrangler.json': '{"name":"x"}' }),
    ).toMatchObject({
      install: 'yarn install --immutable',
    });
  });

  it('keeps a project without package.json, a Wrangler config or a Worker name as code only, saying why', () => {
    expect(buildPlan({ 'package.json': PACKAGE })).toMatchObject({ deployable: false });
    expect(buildPlan({ 'wrangler.json': '{"name":"x"}' })).toMatchObject({ deployable: false });
    expect(buildPlan({ 'package.json': PACKAGE, 'wrangler.json': '{"main":"src/index.ts"}' })).toMatchObject({
      deployable: false,
      reason: expect.stringContaining('needs a name for the Worker'),
    });
    expect(buildPlan({ 'package.json': PACKAGE, 'wrangler.json': '{ not json' })).toMatchObject({ deployable: false });
  });

  it('leaves comment marks inside strings alone', () => {
    expect(JSON.parse(withoutJsonComments('{"url": "https://example.com/*x*/" // c\n}'))).toEqual({
      url: 'https://example.com/*x*/',
    });
  });
});

describe('the Worker an uploaded project deploys as', () => {
  const project = 'eb652428-92ce-498e-8457-37e871c36aea';

  it('is the name its config gives, unless the account has a Worker by that name already, or it is CloudChef’s', () => {
    expect(
      deployWorkerName({ recorded: null, configName: 'glossary', projectId: project, configNameTaken: false }),
    ).toEqual({
      name: 'glossary',
      nameTaken: false,
    });
    expect(
      deployWorkerName({ recorded: null, configName: 'glossary', projectId: project, configNameTaken: true }),
    ).toEqual({
      name: 'glossary-eb65',
      nameTaken: true,
    });
    expect(
      deployWorkerName({ recorded: null, configName: 'cloudchef', projectId: project, configNameTaken: false }).name,
    ).toBe('site-cloudchef-eb65');
    // Once it has deployed, it keeps its Worker.
    expect(
      deployWorkerName({ recorded: 'glossary-eb65', configName: 'glossary', projectId: project, configNameTaken: true })
        .name,
    ).toBe('glossary-eb65');
  });
});

describe("what a deploy may ask of Cloudflare's API", () => {
  const context = { accountId: 'acc', workerName: 'glossary' };
  const decide = (method: string, path: string) => deployApiDecision({ method, path }, context);

  it('writes only its own Worker, and makes the resources its config asks for', () => {
    expect(decide('PUT', '/accounts/acc/workers/scripts/glossary')).toBe('with_token');
    expect(decide('POST', '/accounts/acc/workers/scripts/glossary/assets-upload-session')).toBe('with_token');
    expect(decide('POST', '/accounts/acc/workers/scripts/glossary/versions')).toBe('with_token');
    expect(decide('POST', '/accounts/acc/d1/database')).toBe('with_token');
    expect(decide('POST', '/accounts/acc/d1/database/11111111-1111-4111-8111-111111111111/query')).toBe('with_token');
    expect(decide('PUT', '/accounts/acc/workers/scripts/cloudchef')).toBe('refused');
    expect(decide('PUT', '/accounts/acc/workers/scripts/other-site')).toBe('refused');
    expect(decide('DELETE', '/accounts/acc/workers/scripts/glossary')).toBe('refused');
  });

  it('reads the account’s Workers and resources but not stored values, nor another account', () => {
    expect(decide('GET', '/accounts/acc/workers/subdomain')).toBe('with_token');
    expect(decide('GET', '/memberships')).toBe('with_token');
    expect(decide('GET', '/accounts/acc/storage/kv/namespaces')).toBe('with_token');
    expect(decide('GET', '/accounts/acc/storage/kv/namespaces/ns/values/secret')).toBe('refused');
    expect(decide('GET', '/accounts/acc/secrets_store/stores')).toBe('refused');
    expect(decide('GET', '/accounts/other/workers/scripts')).toBe('refused');
  });

  it('sends asset uploads on with their own authorization', () => {
    expect(decide('POST', '/accounts/acc/workers/assets/upload')).toBe('as_sent');
  });
});
