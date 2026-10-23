import { readFileSync } from 'node:fs';
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
const agentRequiredPackages = ['zod'];
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
  'cf',
  // Only for local D1 migrations (scripts/apply-d1-migrations.mjs --local), since `cf d1 migrations apply --local`
  // never exits; @cloudflare/vitest-plugin brings its own. Production reads and writes go through cf.
  'wrangler',
];
const forbiddenLockfiles = ['package-lock.json'];
const blockedRootBuildEntries = new Map([
  ['@google/genai', "  '@google/genai': false"],
  ['@mongodb-js/zstd', "  '@mongodb-js/zstd': false"],
  ['node-liblzma', '  node-liblzma: false'],
  ['protobufjs', '  protobufjs: false'],
]);
// The project documents nothing else reads. Source files, the template lockfile, and the pnpm patch need no entry:
// the build, the template verifier, and `pnpm install` fail without them.
const requiredPaths = [
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES',
];
function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
}

export function findForbiddenFiles(paths) {
  return findForbiddenPaths(rootDir, paths, 'CloudChef uses pnpm lockfiles only');
}

export function findForbiddenRuntimeEnvAccess(files, allowlist = runtimeEnvAccessAllowlist) {
  return findForbiddenRuntimeEnvAccessShared(files, allowlist);
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

  verifyWorkspace(errors);
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
