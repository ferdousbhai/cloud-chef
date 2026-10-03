import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_REQUIRED_PACKAGES,
  SHARED_APP_PACKAGES,
  CONTROL_PLANE_TOOLCHAIN,
  GENERATED_APP_TOOLCHAIN,
  collectSourceEntries,
  dependencyNames,
  findForbiddenDependencies,
  findBuildApprovalErrors,
  findForbiddenImports,
  findForbiddenPaths,
  findForbiddenRuntimeEnvAccess as findForbiddenRuntimeEnvAccessShared,
  findMissingCommandSteps,
  findMissingDependencies,
  findMissingPaths,
  findPackageVersionAlignmentErrors,
  findRuntimePinErrors,
  packageDependencyVersion,
} from '../template/scripts/lib/project-policy.mjs';
import { runVerifierIfMain } from './run-verifier.mjs';
import {
  CF_COMPATIBILITY_DATE,
  CF_LOGS_HEAD_SAMPLING_RATE,
  CF_TRACES_HEAD_SAMPLING_RATE,
  WEB_APP_RUN_WORKER_FIRST,
} from '../template/scripts/lib/cloudflare-project.mjs';
import { templateSourceDigest } from './template-source.mjs';
import { verifyD1MigrationSafety } from './verify-d1-migrations.mjs';

export {
  CONTROL_PLANE_TOOLCHAIN,
  GENERATED_APP_TOOLCHAIN,
  dependencyNames,
  findForbiddenDependencies,
  findForbiddenImports,
  findMissingCommandSteps,
  findMissingDependencies,
  findPackageVersionAlignmentErrors,
  findRuntimePinErrors,
  packageDependencyVersion,
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeEnvAccessAllowlist = [{ pathSuffix: 'app/components/ErrorComponent.tsx', snippet: 'import.meta.env.DEV' }];
const agentRequiredPackages = ['ai', 'zod'];
/**
 * The control plane's own stack. `app/routeTree.gen.ts` here is written by the TanStack Start vite
 * plugin and nothing else — `scripts/generate-route-tree.mjs` resolves this repository's own vite
 * config to run that plugin's codegen outside a build, so `typecheck` still sees a route added a
 * moment ago. Generated applications choose their own framework and share only the toolchain.
 */
const rootRequiredPackages = [
  ...SHARED_APP_PACKAGES,
  '@tanstack/react-router',
  '@tanstack/react-start',
  '@vitejs/plugin-react',
  'react',
  'react-dom',
  '@cloudflare/vite-plugin',
  'wrangler',
];
const forbiddenLockfiles = ['package-lock.json'];
const blockedRootBuildEntries = new Map([
  ['@google/genai', "  '@google/genai': false"],
  ['@mongodb-js/zstd', "  '@mongodb-js/zstd': false"],
  ['node-liblzma', '  node-liblzma: false'],
  ['protobufjs', '  protobufjs: false'],
]);
const forbiddenLegacyPaths = [
  '.cursor/rules/convex_rules.mdc',
  'app/components/convex',
  'app/components/chat/ChefAuthWrapper.tsx',
  'app/components/chat/ModelSelector.tsx',
  'app/lib/.server/llm/convex-agent.ts',
  'app/lib/convexOptins.ts',
  'app/lib/convexProfile.ts',
  'app/lib/convexUsage.ts',
  'app/routes/api.convex.callback.ts',
  'chef-agent',
  'convex',
  'template/convex',
  'app/lib/webcontainer',
  'app/routes/webcontainer.preview.$id.tsx',
  'iframe-worker',
  'proxy',
  'public/template-snapshot-manifest.json',
];
const requiredPaths = [
  '.github/workflows/runtime-artifacts.yml',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'patches/@cloudflare__computer@0.2.1.patch',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES',
  'app/server.ts',
  'app/agents/builder-agent.ts',
  'app/lib/.server/chat.ts',
  'app/lib/.server/cloudflare/deployment-runtime-policy.ts',
  'app/lib/.server/cloudflare/user-workspace-deployment-executor.ts',
  'user-workspace-runtime/src/index.ts',
  'app/lib/workers-ai-model.ts',
  'cloudchef-agent/package.json',
  'cloudchef-agent/tsconfig.json',
  'scripts/check-runtime-artifacts.mjs',
  'template/package.json',
  'template/pnpm-lock.yaml',
  'template/src/server.ts',
  'template/src/agents/app-agent.ts',
  'template/src/agents/anonymous-retention.ts',
  'template/vite.config.ts',
  'template/cloudflare.config.ts',
  'template/cloudflare.project.json',
];
const requiredMigrationTables = [
  'user',
  'cloudflare_auth_sessions',
  'cloudflare_oauth_states',
  'cloudflare_credentials',
  'cloudflare_connections',
  'user_computer_runtimes',
];
const forbiddenCentralWorkloadTables = [
  'chats',
  'chat_message_states',
  'chat_transcripts',
  'shares',
  'social_shares',
  'object_gc_candidates',
  'agent_gc_candidates',
  'deployments',
  'deployment_resources',
  'deployment_security_inventory',
  'chat_backup_admissions',
  'chat_backup_objects',
  'chat_backup_object_attributions',
  'chat_backup_reconciliation_state',
  'thumbnail_upload_admissions',
  'thumbnail_objects',
  'thumbnail_reconciliation_state',
  'skill_sync_state',
  'skill_sync_entries',
  'builder_previews',
  'builder_preview_build_admissions',
  'sandbox_cleanup_candidates',
  'feedback',
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
}

export function findForbiddenFiles(paths) {
  return findForbiddenPaths(rootDir, paths, 'CloudChef uses pnpm lockfiles only');
}

export function findForbiddenLegacyPaths(paths) {
  return findForbiddenPaths(rootDir, paths, 'CloudChef uses TanStack Start and Cloudflare-only providers');
}

export function findForbiddenRuntimeEnvAccess(files, allowlist = runtimeEnvAccessAllowlist) {
  return findForbiddenRuntimeEnvAccessShared(files, allowlist);
}

export function findForbiddenRootBrowserRuntimeDependencies(pkg) {
  const forbidden = ['@webcontainer/api', '@webcontainer/snapshot', '@xterm/xterm', '@xterm/addon-fit'];
  const dependencies = dependencyNames(pkg);
  return forbidden
    .filter((name) => dependencies.has(name))
    .map((name) => `package.json must not depend on the removed browser execution runtime ${name}.`);
}

export function findSandboxRuntimePinErrors(packageSpec, installedVersion, provisionerSource) {
  const errors = [];
  const image = /docker\.io\/cloudflare\/sandbox:([^@'\s]+)@sha256:([a-f0-9]{64})/.exec(provisionerSource);
  if (!image) {
    return ['user workspace runtime must pin a Cloudflare Sandbox image tag and SHA-256 digest.'];
  }
  if (image[1] !== installedVersion) {
    errors.push(`Cloudflare Sandbox package ${installedVersion} must match container image tag ${image[1]}.`);
  }
  if (packageSpec !== installedVersion) {
    errors.push(`package.json must pin the installed Cloudflare Sandbox version ${installedVersion} exactly.`);
  }
  return errors;
}

export function findBuilderTemplateModuleErrors(content, sourceSha256) {
  return content.includes(`export const BUILDER_TEMPLATE_SOURCE_SHA256 = '${sourceSha256}';`)
    ? []
    : ['app/agents/builder-template.generated.ts is stale; run pnpm run generate:artifacts.'];
}

/** The generated template's deployment policy must match what the control plane publishes. */
export function findDeploymentRuntimePolicyErrors(templatePolicy, runtimePolicySource) {
  const runtimePolicy = {
    compatibilityDate: /export const DEPLOYMENT_COMPATIBILITY_DATE = '([^']+)'/.exec(runtimePolicySource)?.[1],
    logsHeadSamplingRate: Number(/logs: \{[^}]*head_sampling_rate: ([0-9.]+)/.exec(runtimePolicySource)?.[1]),
    tracesHeadSamplingRate: Number(/traces: \{[^}]*head_sampling_rate: ([0-9.]+)/.exec(runtimePolicySource)?.[1]),
    assetsRunWorkerFirst: normalizedStringList(
      /export const DEPLOYMENT_ASSETS_RUN_WORKER_FIRST = (\[[^\]]*\])/.exec(runtimePolicySource)?.[1],
    ),
  };
  return Object.entries(templatePolicy).flatMap(([name, value]) =>
    runtimePolicy[name] === value
      ? []
      : [
          `deployment ${name} ${JSON.stringify(runtimePolicy[name])} must match the generated template's ${JSON.stringify(value)}.`,
        ],
  );
}

/** A single-quoted TypeScript string array, as compact JSON; anything else is undefined. */
function normalizedStringList(source) {
  try {
    return JSON.stringify(JSON.parse(source.replaceAll("'", '"')));
  } catch {
    return undefined;
  }
}

function verifyPackage(errors, pkg, label, requiredPackages, toolchain) {
  errors.push(
    ...findForbiddenDependencies(pkg, label),
    ...findMissingDependencies(pkg, label, requiredPackages),
    ...findRuntimePinErrors(pkg, label, toolchain),
  );
}

export function findInternalPackageMetadataErrors(pkg, label) {
  return pkg?.private === true ? [] : [`${label} must set private to true so it cannot be published accidentally.`];
}

export function findRootWorkspacePolicyErrors(workspace) {
  const errors = [];
  for (const packagePath of ['cloudchef-agent', 'template']) {
    if (!new RegExp(`- ['"]?${packagePath}['"]?`).test(workspace)) {
      errors.push(`pnpm-workspace.yaml must include ${packagePath}.`);
    }
  }
  let generatedProjectPolicy = workspace;
  for (const [dependency, entry] of blockedRootBuildEntries) {
    const pattern = new RegExp(`^${escapeRegExp(entry)}$`, 'gm');
    const matches = workspace.match(pattern) ?? [];
    if (matches.length !== 1) {
      errors.push(`pnpm-workspace.yaml must explicitly block ${dependency} exactly once.`);
    }
    generatedProjectPolicy = generatedProjectPolicy.replace(pattern, '');
  }
  const computerSqlPatch =
    /^patchedDependencies:\n  '@cloudflare\/computer@0\.2\.1': patches\/@cloudflare__computer@0\.2\.1\.patch$/gm;
  const computerSqlPatchEntries = workspace.match(computerSqlPatch) ?? [];
  if (computerSqlPatchEntries.length !== 1) {
    errors.push('pnpm-workspace.yaml must apply the reviewed Computer 0.2.1 SQL probe patch exactly once.');
  }
  errors.push(...findBuildApprovalErrors(generatedProjectPolicy.replace(computerSqlPatch, ''), 'pnpm-workspace.yaml'));
  if (/set this to true or false/i.test(workspace)) {
    errors.push('pnpm-workspace.yaml must not contain unresolved build-approval placeholders.');
  }
  return errors;
}

function verifyWorkspace(errors) {
  const workspace = readFileSync(resolve(rootDir, 'pnpm-workspace.yaml'), 'utf8');
  errors.push(...findRootWorkspacePolicyErrors(workspace));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verifyToolchainConfig(errors, rootPackage) {
  const nodeVersion = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8').trim();
  if (nodeVersion !== '26.3.0') {
    errors.push('.nvmrc must pin Node.js 26.3.0.');
  }
  if (rootPackage?.packageManager !== 'pnpm@11.14.0') {
    errors.push('package.json must pin pnpm 11.14.0 for Cloudflare Workers Builds.');
  }
}

function verifyRootMigrations(errors) {
  const migrationsDir = resolve(rootDir, 'migrations');
  const sql = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'))
    .join('\n');
  errors.push(...findRootMigrationErrors(sql));
}

export function findRootMigrationErrors(sql) {
  const errors = [];
  // The trailing boundary keeps the name an exact match: without it `user` matched the first four
  // characters of `user_computer_runtimes`, so the required-table check passed vacuously.
  for (const table of requiredMigrationTables) {
    if (!new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ["']?${table}["']?(?![A-Za-z0-9_])`, 'i').test(sql)) {
      errors.push(`root migrations must create the ${table} table.`);
    }
  }
  for (const table of forbiddenCentralWorkloadTables) {
    if (new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ["']?${table}["']?(?![A-Za-z0-9_])`, 'i').test(sql)) {
      errors.push(`root migrations must not create the user-owned ${table} workload table.`);
    }
  }
  return errors;
}

export function verifyStackAlignment() {
  const errors = [];
  const rootPackage = readJson('package.json');
  const agentPackage = readJson('cloudchef-agent/package.json');
  const templatePackage = readJson('template/package.json');
  const sandboxPackage = readJson('node_modules/@cloudflare/sandbox/package.json');

  verifyPackage(errors, rootPackage, 'package.json', rootRequiredPackages, CONTROL_PLANE_TOOLCHAIN);
  verifyPackage(errors, agentPackage, 'cloudchef-agent/package.json', agentRequiredPackages, CONTROL_PLANE_TOOLCHAIN);
  verifyPackage(errors, templatePackage, 'template/package.json', APP_REQUIRED_PACKAGES, GENERATED_APP_TOOLCHAIN);
  errors.push(
    ...findForbiddenRootBrowserRuntimeDependencies(rootPackage),
    ...findInternalPackageMetadataErrors(rootPackage, 'package.json'),
    ...findInternalPackageMetadataErrors(agentPackage, 'cloudchef-agent/package.json'),
    ...findInternalPackageMetadataErrors(templatePackage, 'template/package.json'),
    ...findPackageVersionAlignmentErrors(
      rootPackage,
      agentPackage,
      'cloudchef-agent/package.json',
      agentRequiredPackages,
    ),
    ...findPackageVersionAlignmentErrors(rootPackage, templatePackage, 'template/package.json', SHARED_APP_PACKAGES),
    ...findForbiddenFiles(forbiddenLockfiles),
    ...findForbiddenLegacyPaths(forbiddenLegacyPaths),
    ...findMissingPaths(rootDir, requiredPaths),
    ...findSandboxRuntimePinErrors(
      rootPackage.dependencies?.['@cloudflare/sandbox'],
      sandboxPackage.version,
      readFileSync(resolve(rootDir, 'app/workflows/user-workspace-runtime-provisioning.ts'), 'utf8'),
    ),
  );

  if (rootPackage.license !== 'Apache-2.0') {
    errors.push('package.json must declare Apache-2.0 licensing.');
  }
  errors.push(
    ...findMissingCommandSteps(rootPackage.scripts?.validate, 'package.json scripts.validate', [
      'validate:root',
      'validate:agent',
      'validate:template',
    ]),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:agent'], 'package.json scripts.validate:agent', [
      'cloudchef-agent',
      'typecheck',
    ]),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:root'], 'package.json scripts.validate:root', [
      'generate',
      'verify:stack',
      'verify:production-config',
      'verify:licenses',
      'audit:dependencies',
      'typecheck',
      'lint',
      'test',
      'knip',
      'build',
      'verify:built-ssr',
      'verify:static-assets',
      'bundle:check',
    ]),
    ...findMissingCommandSteps(
      rootPackage.scripts?.['validate:public-beta'],
      'package.json scripts.validate:public-beta',
      ['validate', 'verify:built-browser'],
    ),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:template'], 'package.json scripts.validate:template', [
      'scripts/verify-template.mjs',
    ]),
  );

  verifyWorkspace(errors);
  verifyToolchainConfig(errors, rootPackage);
  verifyRootMigrations(errors);
  errors.push(...verifyD1MigrationSafety(rootDir));
  errors.push(
    ...findDeploymentRuntimePolicyErrors(
      {
        compatibilityDate: CF_COMPATIBILITY_DATE,
        logsHeadSamplingRate: CF_LOGS_HEAD_SAMPLING_RATE,
        tracesHeadSamplingRate: CF_TRACES_HEAD_SAMPLING_RATE,
        assetsRunWorkerFirst: JSON.stringify(WEB_APP_RUN_WORKER_FIRST),
      },
      readFileSync(resolve(rootDir, 'app/lib/.server/cloudflare/deployment-runtime-policy.ts'), 'utf8'),
    ),
  );

  errors.push(
    ...findBuilderTemplateModuleErrors(
      readFileSync(resolve(rootDir, 'app/agents/builder-template.generated.ts'), 'utf8'),
      templateSourceDigest(rootDir),
    ),
  );

  const sourceFiles = collectSourceEntries(rootDir, [
    'app',
    'cloudchef-agent',
    'template/src',
    'vite.config.ts',
    'template/vite.config.ts',
  ]).filter((path) => !path.endsWith('/app/generated/user-workspace-runtime.generated.ts'));
  errors.push(...findForbiddenImports(sourceFiles), ...findForbiddenRuntimeEnvAccess(sourceFiles));

  return errors;
}

runVerifierIfMain(import.meta.url, verifyStackAlignment);
