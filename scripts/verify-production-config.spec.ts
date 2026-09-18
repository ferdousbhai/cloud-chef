import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findDurableObjectLifecycleErrors,
  findWorkerObservabilityErrors,
  findWorkerOAuthStartRateLimitErrors,
  findWorkerGcScheduleErrors,
  findWorkerOperationsSecretErrors,
  findWorkerRoutingErrors,
  findWorkerRuntimeSecretErrors,
  findWorkerVariableSourceErrors,
  verifyProductionConfig,
  workflowPathsFromDirectoryEntries,
} from './verify-production-config.mjs';
import {
  findBuildApprovalErrors,
  findMissingProvisionScriptPatternErrors,
} from '../template/scripts/lib/project-policy.mjs';

describe('findDurableObjectLifecycleErrors', () => {
  const classNames = ['BuilderAgent', 'DeploymentSandbox'];

  it('accepts declarative live SQLite exports for every bound class', () => {
    expect(
      findDurableObjectLifecycleErrors(
        {
          durable_objects: {
            bindings: classNames.map((class_name) => ({ name: class_name, class_name })),
          },
          exports: Object.fromEntries(
            classNames.map((className) => [className, { type: 'durable-object', storage: 'sqlite' }]),
          ),
        },
        'wrangler.jsonc',
        classNames,
      ),
    ).toEqual([]);
  });

  it('rejects the legacy flow and incomplete lifecycle declarations', () => {
    expect(
      findDurableObjectLifecycleErrors(
        {
          migrations: [{ tag: 'v1', new_sqlite_classes: ['BuilderAgent'] }],
          durable_objects: { bindings: [{ name: 'BuilderAgent', class_name: 'BuilderAgent' }] },
          exports: { BuilderAgent: { type: 'durable-object', storage: 'sqlite' } },
        },
        'wrangler.jsonc',
        classNames,
      ),
    ).toEqual([
      'wrangler.jsonc must use declarative exports instead of the legacy Durable Object migrations flow.',
      'wrangler.jsonc must bind the DeploymentSandbox Durable Object.',
      'wrangler.jsonc must declare the DeploymentSandbox Durable Object as a live SQLite export.',
    ]);
  });
});

describe('findWorkerRoutingErrors', () => {
  it('accepts the production custom domain with workers.dev disabled', () => {
    expect(
      findWorkerRoutingErrors(
        {
          workers_dev: false,
          routes: [
            { pattern: 'cloudchef.build', custom_domain: true },
            { pattern: 'www.cloudchef.build', custom_domain: true },
          ],
        },
        'wrangler.jsonc',
        ['cloudchef.build', 'www.cloudchef.build'],
      ),
    ).toEqual([]);
  });

  it('rejects a missing custom domain and public workers.dev endpoint', () => {
    expect(findWorkerRoutingErrors({}, 'wrangler.jsonc', ['cloudchef.build', 'www.cloudchef.build'])).toEqual([
      'wrangler.jsonc workers_dev must be false so production is served only from the custom domain.',
      'wrangler.jsonc must configure "cloudchef.build" as a custom domain.',
      'wrangler.jsonc must configure "www.cloudchef.build" as a custom domain.',
    ]);
  });
});

describe('findWorkerVariableSourceErrors', () => {
  it('keeps deploy-provided variables out of checked-in Wrangler state', () => {
    expect(findWorkerVariableSourceErrors({ vars: { STATIC_VALUE: 'ok' } }, 'wrangler.jsonc')).toEqual([]);
    expect(
      findWorkerVariableSourceErrors(
        { keep_vars: true, vars: { CLOUDFLARE_OAUTH_CLIENT_ID: 'dashboard-dependent' } },
        'wrangler.jsonc',
      ),
    ).toEqual([
      'wrangler.jsonc must omit keep_vars so checked-in config and deploy arguments remain the source of truth.',
      'wrangler.jsonc must not commit CLOUDFLARE_OAUTH_CLIENT_ID; inject it from the deploy environment.',
    ]);
  });
});

describe('findWorkerGcScheduleErrors', () => {
  it('requires the bounded authentication-metadata retention cron', () => {
    expect(findWorkerGcScheduleErrors({ triggers: { crons: ['*/15 * * * *'] } }, 'wrangler.jsonc')).toEqual([]);
    expect(findWorkerGcScheduleErrors({}, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc must schedule bounded authentication-metadata retention every 15 minutes.',
    ]);
  });
});

describe('findWorkerOperationsSecretErrors', () => {
  it('keeps the retired operations credential from returning to the wire', () => {
    expect(findWorkerOperationsSecretErrors({}, 'wrangler.jsonc')).toEqual([]);
    expect(findWorkerOperationsSecretErrors({ secrets_store_secrets: [] }, 'wrangler.jsonc')).toEqual([]);
    expect(
      findWorkerOperationsSecretErrors(
        {
          secrets_store_secrets: [
            {
              binding: 'OPS_AUTH_SECRET',
              store_id: 'a436a6cefedc4acd8bb920cdbc202c1c',
              secret_name: 'cloudchef-ops-auth',
            },
          ],
        },
        'wrangler.jsonc',
      ),
    ).toEqual([
      'wrangler.jsonc must not bind the retired operations secret (cloudchef-ops-auth); private operations are authorized by the OperationsService Service binding.',
    ]);
  });

  it('still allows genuinely account-wide Secrets Store bindings', () => {
    expect(
      findWorkerOperationsSecretErrors(
        { secrets_store_secrets: [{ binding: 'OPENROUTER_API_KEY', secret_name: 'open-router' }] },
        'wrangler.jsonc',
      ),
    ).toEqual([]);
  });
});

describe('findWorkerOAuthStartRateLimitErrors', () => {
  it('requires a dedicated 10-per-minute namespace', () => {
    expect(
      findWorkerOAuthStartRateLimitErrors(
        {
          ratelimits: [
            {
              name: 'CLOUDFLARE_OAUTH_START_RATE_LIMITER',
              namespace_id: '1002',
              simple: { limit: 10, period: 60 },
            },
          ],
        },
        'wrangler.jsonc',
      ),
    ).toEqual([]);
    expect(findWorkerOAuthStartRateLimitErrors({}, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc must bind CLOUDFLARE_OAUTH_START_RATE_LIMITER.',
    ]);
    expect(
      findWorkerOAuthStartRateLimitErrors(
        {
          ratelimits: [
            {
              name: 'CLOUDFLARE_OAUTH_START_RATE_LIMITER',
              namespace_id: '1001',
              simple: { limit: 30, period: 10 },
            },
          ],
        },
        'wrangler.jsonc',
      ),
    ).toEqual([
      'wrangler.jsonc OAuth-start rate-limit namespace_id must be "1002"; found "1001".',
      'wrangler.jsonc OAuth-start rate-limit simple.limit must be 10; found 30.',
      'wrangler.jsonc OAuth-start rate-limit simple.period must be 60; found 10.',
    ]);
  });
});

describe('production config workflow verification helpers', () => {
  const configErrors = verifyProductionConfig();

  it('rejects unreviewed dependency build scripts', () => {
    const workspace = `
minimumReleaseAge: 0
minimumReleaseAgeStrict: false
trustLockfile: true
minimumReleaseAgeExclude:
  - unexpected-installer
strictDepBuilds: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
  unexpected-installer: true
dangerouslyAllowAllBuilds: true
`;

    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).toContain(
      'pnpm-workspace.yaml allowBuilds must not approve unexpected package unexpected-installer.',
    );
    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).toContain(
      'pnpm-workspace.yaml must not define dangerouslyAllowAllBuilds.',
    );
    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).toEqual(
      expect.arrayContaining([
        'pnpm-workspace.yaml must set minimumReleaseAge to 1440 minutes.',
        'pnpm-workspace.yaml must enable minimumReleaseAgeStrict.',
        'pnpm-workspace.yaml must not define trustLockfile.',
        'pnpm-workspace.yaml must not define minimumReleaseAgeExclude.',
      ]),
    );
  });

  it.each([
    '"trustLockfile": true',
    "'minimumReleaseAgeExclude': [malicious-package]",
    '"dangerouslyAllow\\u0041llBuilds": true',
    '"trustLock\\u0066ile": true',
    '"minimumReleaseAge\\u0045xclude": [malicious-package]',
    'minimumReleaseAge: 1440\nminimumReleaseAge: 0',
    '"minimumRelease\\u0041ge": 0',
    'minimumReleaseAgeStrict: true\nminimumReleaseAgeStrict: false',
  ])('rejects ambiguous or quoted dependency-cooling policy: %s', (weakening) => {
    const workspace = `
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
strictDepBuilds: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
${weakening}
`;

    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).not.toEqual([]);
  });

  it('rejects workspace policy text larger than 64 KiB before parsing', () => {
    expect(findBuildApprovalErrors('x'.repeat(64 * 1024 + 1), 'pnpm-workspace.yaml')).toEqual([
      'pnpm-workspace.yaml must not exceed 65536 UTF-8 bytes.',
    ]);
  });

  it('accepts different safe in-tree workspace package shapes', () => {
    expect(
      findBuildApprovalErrors(
        workspacePolicyFixture(['cloudchef-agent', 'template', 'packages/*', '!packages/legacy/**']),
        'pnpm-workspace.yaml',
      ),
    ).toEqual([]);
    expect(findBuildApprovalErrors(workspacePolicyFixture(['.']), 'template/pnpm-workspace.yaml')).toEqual([]);
  });

  it('allows only the reviewed transitive vulnerability overrides', () => {
    const reviewed = `${workspacePolicyFixture(['cloudchef-agent', 'template'])}
overrides:
  'brace-expansion@<1.1.18': '1.1.18'
  'brace-expansion@>=2.0.0 <2.1.4': '2.1.4'
  'brace-expansion@>=4.0.0 <5.0.9': '5.0.9'
  '@hono/node-server@<2.0.10': '2.0.10'
  'browserslist@<=4.28.6': '4.28.8'
  'fast-uri@>=3.0.0 <3.1.6': '3.1.6'
  'hono@<4.13.5': '4.13.5'
  'ip-address@<=10.3.0': '10.3.1'
  'js-yaml@>=4.0.0 <4.3.2': '4.3.2'
  'nanoid@<3.3.18': '3.3.18'
  'postcss@<=8.5.22': '8.5.25'
  'qs@<6.16.0': '6.16.0'
  'smol-toml@<1.7.1': '1.8.0'
  'sharp@<0.35.4': '0.35.4'
  'undici@>=7.0.0 <7.29.0': '7.29.0'
`;
    expect(findBuildApprovalErrors(reviewed, 'pnpm-workspace.yaml')).toEqual([]);

    const unreviewed = `${workspacePolicyFixture(['cloudchef-agent', 'template'])}
overrides:
  'brace-expansion@<1.1.18': '1.1.17'
  'malicious-package@*': 'file:../outside'
`;
    expect(findBuildApprovalErrors(unreviewed, 'pnpm-workspace.yaml')).toEqual(
      expect.arrayContaining([
        'pnpm-workspace.yaml overrides must not change unreviewed dependency brace-expansion@<1.1.18.',
        'pnpm-workspace.yaml overrides must not change unreviewed dependency malicious-package@*.',
        'pnpm-workspace.yaml overrides must pin brace-expansion@<1.1.18 to 1.1.18.',
        'pnpm-workspace.yaml overrides must pin brace-expansion@>=2.0.0 <2.1.4 to 2.1.4.',
        'pnpm-workspace.yaml overrides must pin brace-expansion@>=4.0.0 <5.0.9 to 5.0.9.',
        'pnpm-workspace.yaml overrides must pin @hono/node-server@<2.0.10 to 2.0.10.',
        'pnpm-workspace.yaml overrides must pin browserslist@<=4.28.6 to 4.28.8.',
        'pnpm-workspace.yaml overrides must pin fast-uri@>=3.0.0 <3.1.6 to 3.1.6.',
        'pnpm-workspace.yaml overrides must pin hono@<4.13.5 to 4.13.5.',
        'pnpm-workspace.yaml overrides must pin ip-address@<=10.3.0 to 10.3.1.',
        'pnpm-workspace.yaml overrides must pin js-yaml@>=4.0.0 <4.3.2 to 4.3.2.',
        'pnpm-workspace.yaml overrides must pin nanoid@<3.3.18 to 3.3.18.',
        'pnpm-workspace.yaml overrides must pin postcss@<=8.5.22 to 8.5.25.',
        'pnpm-workspace.yaml overrides must pin qs@<6.16.0 to 6.16.0.',
        'pnpm-workspace.yaml overrides must pin smol-toml@<1.7.1 to 1.8.0.',
        'pnpm-workspace.yaml overrides must pin sharp@<0.35.4 to 0.35.4.',
        'pnpm-workspace.yaml overrides must pin undici@>=7.0.0 <7.29.0 to 7.29.0.',
      ]),
    );
  });

  it.each([
    '../outside',
    'packages/../../outside',
    '/tmp/package',
    'https://example.com/package',
    'file:../outside',
    'C:\\outside',
    '\\\\server\\share',
    '~/.cache/package',
    '{..,packages}/*',
    '@(../outside|packages)',
    'packages//nested',
    ' packages/*',
    'packages/* ',
  ])('rejects unsafe workspace package path or glob: %s', (workspacePackage) => {
    expect(findBuildApprovalErrors(workspacePolicyFixture([workspacePackage]), 'pnpm-workspace.yaml')).toContain(
      `pnpm-workspace.yaml packages must contain only safe in-tree relative paths or globs; found ${JSON.stringify(workspacePackage)}.`,
    );
  });

  it('requires a non-empty package list and the workspace-root installation guard', () => {
    expect(findBuildApprovalErrors(workspacePolicyFixture([], false), 'pnpm-workspace.yaml')).toEqual(
      expect.arrayContaining([
        'pnpm-workspace.yaml packages must be a non-empty sequence.',
        'pnpm-workspace.yaml must enable ignoreWorkspaceRootCheck.',
      ]),
    );
  });

  it('keeps GitHub deployment Actions disabled', () => {
    // The browser gate is the only release check GitHub Actions owns; the
    // Workers Builds image cannot install Chromium.
    expect(readdirSync('.github/workflows').sort()).toEqual(['browser-gate.yml', 'runtime-artifacts.yml']);
    expect(existsSync('.github/actions/setup-and-build/action.yaml')).toBe(false);
  });

  it('allows required secret names but rejects values and unknown shapes', () => {
    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: { required: ['API_KEY', 'SIGNING_KEY'] } },
        'template/wrangler.jsonc',
        'configure values outside source control',
      ),
    ).toEqual([]);

    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: [{ name: 'API_KEY' }] },
        'template/wrangler.jsonc',
        'generated apps should configure runtime values as Cloudflare bindings',
      ),
    ).toEqual([
      'template/wrangler.jsonc secrets may declare only unique, non-empty names in secrets.required; generated apps should configure runtime values as Cloudflare bindings.',
    ]);

    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: { required: ['API_KEY'], API_KEY: 'secret-value' } },
        'wrangler.jsonc',
        'configure values outside source control',
      ),
    ).toEqual([
      'wrangler.jsonc secrets may declare only unique, non-empty names in secrets.required; configure values outside source control.',
    ]);

    expect(
      findWorkerRuntimeSecretErrors({}, 'wrangler.jsonc', 'configure runtime values as Cloudflare bindings'),
    ).toEqual([]);
  });

  it('requires explicit Worker logs and traces sampling', () => {
    expect(
      findWorkerObservabilityErrors(
        {
          observability: {
            enabled: true,
            logs: { enabled: true, head_sampling_rate: 0.6 },
            traces: { enabled: true, head_sampling_rate: 0.05 },
          },
        },
        'wrangler.jsonc',
      ),
    ).toEqual([]);

    expect(findWorkerObservabilityErrors({ observability: { enabled: true } }, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc observability.logs.enabled must be true; found undefined.',
      'wrangler.jsonc observability.logs.head_sampling_rate must be 0.6; found undefined.',
      'wrangler.jsonc observability.traces.enabled must be true; found undefined.',
      'wrangler.jsonc observability.traces.head_sampling_rate must be 0.05; found undefined.',
    ]);
  });

  it('requires production provisioning scripts to perform required Cloudflare setup without local secret gates', () => {
    expect(
      findMissingProvisionScriptPatternErrors('pnpm wrangler r2 bucket list', 'scripts/provision.mjs', [
        { pattern: /wrangler d1 list/, description: 'list Cloudflare D1 databases' },
      ]),
    ).toEqual(['scripts/provision.mjs must list Cloudflare D1 databases.']);

    expect(
      findMissingProvisionScriptPatternErrors('pnpm wrangler d1 list', 'scripts/provision.mjs', [
        { pattern: /wrangler d1 list/, description: 'list Cloudflare D1 databases' },
      ]),
    ).toEqual([]);
  });

  it('uses explicit deploy inputs instead of dashboard-preserved variables', () => {
    expect(configErrors).not.toContain(
      'wrangler.jsonc must omit keep_vars so checked-in config and deploy arguments remain the source of truth.',
    );
    expect(configErrors).not.toContain(
      'wrangler.jsonc must not commit CLOUDFLARE_OAUTH_CLIENT_ID; inject it from the deploy environment.',
    );
  });

  it('pins the least-privilege OAuth scope list in Wrangler configuration', () => {
    expect(configErrors.join('\n')).not.toContain('wrangler.jsonc vars.CLOUDFLARE_OAUTH_SCOPES');
  });

  it('discovers every YAML workflow file for production guard checks', () => {
    expect(workflowPathsFromDirectoryEntries(['deploy.yml', 'ci.yaml', 'README.md', 'nested.yml.bak'])).toEqual([
      '.github/workflows/ci.yaml',
      '.github/workflows/deploy.yml',
    ]);
  });

  it('keeps Cloudflare type generation bounded in browser containers', () => {
    const script = readFileSync('template/scripts/cf-typegen.mjs', 'utf8');

    expect(script).toContain('timeout: WRANGLER_TYPES_TIMEOUT_MS');
    expect(script).toContain('experimental_generateTypes');
    expect(script).toContain('includeRuntime: false');
    expect(script).toContain('withPackagedRuntimeTypes');
    expect(script).toContain('config?.secrets?.required ?? []');
  });
});

function workspacePolicyFixture(packages: string[], ignoreWorkspaceRootCheck = true): string {
  return `
packages:
${packages.map((workspacePackage) => `  - ${JSON.stringify(workspacePackage)}`).join('\n')}
ignoreWorkspaceRootCheck: ${ignoreWorkspaceRootCheck}
minimumReleaseAge: 1440
minimumReleaseAgeIgnoreMissingTime: false
minimumReleaseAgeStrict: true
strictDepBuilds: true
blockExoticSubdeps: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
`;
}
