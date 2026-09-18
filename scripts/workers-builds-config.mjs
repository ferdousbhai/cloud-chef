const EXPECTED_WORKER = 'cloudchef';
const EXPECTED_REPOSITORY = 'ferdousbhai/cloud-chef';
const EXPECTED_BRANCH = 'main';
const EXPECTED_BUILD_COMMAND = 'pnpm run workers-builds:build';
const EXPECTED_DEPLOY_COMMAND = 'pnpm run workers-builds:deploy';
const EXPECTED_PREVIEW_COMMAND = 'pnpm run workers-builds:preview';
const EXPECTED_TOKEN_NAME = 'account-workers-builds-production';
const EXPECTED_BUILD_VARIABLES = {
  NODE_VERSION: '26.3.0',
  PNPM_VERSION: '11.14.0',
  SKIP_DEPENDENCY_INSTALL: '1',
};
const EXPECTED_REQUIRED_BUILD_VARIABLES = ['CLOUDFLARE_OAUTH_CLIENT_ID'];
// The Workers Builds image cannot install Chromium, so the credential-free
// browser gate is the one release check GitHub Actions owns. Everything else
// stays with Cloudflare.
const REQUIRED_GITHUB_WORKFLOW_PATH = '.github/workflows/browser-gate.yml';
const ALLOWED_GITHUB_WORKFLOW_PATHS = [REQUIRED_GITHUB_WORKFLOW_PATH, '.github/workflows/runtime-artifacts.yml'];

export function findUnexpectedGithubWorkflowPaths(paths) {
  return Array.isArray(paths) ? paths.filter((path) => !ALLOWED_GITHUB_WORKFLOW_PATHS.includes(path)) : [];
}

export function findWorkersBuildsConfigErrors({
  config,
  packageJson,
  nvmrc,
  githubWorkflowPaths,
  browserGateWorkflow,
  githubCompositeActionExists,
  workerConfig,
}) {
  const errors = [];
  requireEqual(errors, 'workers-builds.production.json worker', config?.worker, EXPECTED_WORKER);
  requireEqual(errors, 'workers-builds.production.json repository', config?.repository, EXPECTED_REPOSITORY);
  requireEqual(errors, 'workers-builds.production.json productionBranch', config?.productionBranch, EXPECTED_BRANCH);
  requireEqual(errors, 'workers-builds.production.json rootDirectory', config?.rootDirectory, '/');
  requireEqual(errors, 'workers-builds.production.json buildCommand', config?.buildCommand, EXPECTED_BUILD_COMMAND);
  requireEqual(errors, 'workers-builds.production.json deployCommand', config?.deployCommand, EXPECTED_DEPLOY_COMMAND);
  requireEqual(errors, 'workers-builds.production.json nonProductionBuilds', config?.nonProductionBuilds, true);
  requireEqual(
    errors,
    'workers-builds.production.json nonProductionDeployCommand',
    config?.nonProductionDeployCommand,
    EXPECTED_PREVIEW_COMMAND,
  );
  requireEqual(errors, 'workers-builds.production.json buildCaching', config?.buildCaching, true);
  requireEqual(errors, 'workers-builds.production.json buildTokenName', config?.buildTokenName, EXPECTED_TOKEN_NAME);
  requireStringArray(errors, 'workers-builds.production.json pathIncludes', config?.pathIncludes, ['*']);
  requireStringArray(errors, 'workers-builds.production.json pathExcludes', config?.pathExcludes, []);
  requireStringArray(
    errors,
    'workers-builds.production.json requiredBuildVariables',
    config?.requiredBuildVariables,
    EXPECTED_REQUIRED_BUILD_VARIABLES,
  );
  if (config?.containerImage !== undefined) {
    errors.push('workers-builds.production.json must not build a CloudChef-owned Sandbox image.');
  }
  if (Array.isArray(workerConfig?.containers) && workerConfig.containers.length > 0) {
    errors.push('wrangler.jsonc must not bind CloudChef-owned Containers.');
  }

  if (!isRecord(config?.buildVariables)) {
    errors.push('workers-builds.production.json buildVariables must be an object.');
  } else {
    for (const [name, value] of Object.entries(EXPECTED_BUILD_VARIABLES)) {
      requireEqual(errors, `workers-builds.production.json buildVariables.${name}`, config.buildVariables[name], value);
    }
    // `hasOwn`, not `in`: `in` walks Object.prototype, so a build variable literally named
    // `constructor` or `toString` would be treated as reviewed and never reported.
    const unexpected = Object.keys(config.buildVariables).filter(
      (name) => !Object.hasOwn(EXPECTED_BUILD_VARIABLES, name),
    );
    if (unexpected.length > 0) {
      errors.push(
        `workers-builds.production.json buildVariables must not contain unreviewed variables: ${unexpected.join(', ')}.`,
      );
    }
  }

  const scripts = packageJson?.scripts;
  requireEqual(
    errors,
    'package.json scripts.workers-builds:build',
    scripts?.['workers-builds:build'],
    [
      'pnpm install --frozen-lockfile',
      'node scripts/check-workers-builds-environment.mjs',
      'pnpm run validate',
      'node scripts/deploy-production.mjs --check-workers-builds',
    ].join(' && '),
  );
  requireEqual(
    errors,
    'package.json scripts.workers-builds:deploy',
    scripts?.['workers-builds:deploy'],
    [
      'node scripts/deploy-production.mjs --check-workers-builds',
      'pnpm run provision:production:check',
      'pnpm run verify:production-config',
      'pnpm run verify:workers-builds-config',
      'pnpm run d1:bookmark:production',
      'pnpm run d1:migrations:apply:production',
      'node scripts/deploy-production.mjs',
    ].join(' && '),
  );
  requireEqual(
    errors,
    'package.json scripts.workers-builds:preview',
    scripts?.['workers-builds:preview'],
    'node scripts/upload-workers-builds-preview.mjs',
  );
  requireEqual(errors, 'package.json packageManager', packageJson?.packageManager, 'pnpm@11.14.0');
  requireEqual(errors, '.nvmrc', nvmrc?.trim(), '26.3.0');

  if (
    !githubWorkflowPaths?.includes(REQUIRED_GITHUB_WORKFLOW_PATH) ||
    !browserGateWorkflow?.includes('verify:built-browser')
  ) {
    errors.push(
      `${REQUIRED_GITHUB_WORKFLOW_PATH} must run pnpm run verify:built-browser; the Workers Builds image cannot host the browser gate.`,
    );
  }
  const unexpectedGithubWorkflowPaths = findUnexpectedGithubWorkflowPaths(githubWorkflowPaths);
  if (unexpectedGithubWorkflowPaths.length > 0) {
    errors.push(
      `GitHub deployment workflows must not exist; Cloudflare Workers Builds is the only CI/CD provider. Found: ${unexpectedGithubWorkflowPaths.join(', ')}.`,
    );
  }
  if (githubCompositeActionExists) {
    errors.push(
      '.github/actions/setup-and-build/action.yaml must not exist; the Cloudflare build command owns toolchain setup.',
    );
  }
  return errors;
}

function requireEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function requireStringArray(errors, label, actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => typeof value !== 'string' || value !== expected[index])
  ) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
