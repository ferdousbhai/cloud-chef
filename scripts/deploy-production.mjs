import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1_RESTORE_RECEIPT_MARKER } from './record-d1-time-travel-bookmark.mjs';
import { verifyLocalDeployment } from './verify-live-deployment.mjs';

const CLIENT_ID_ENV = 'CLOUDFLARE_OAUTH_CLIENT_ID';
const MAX_CLIENT_ID_LENGTH = 512;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKERS_BUILD_UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WORKERS_BUILD_GENERATED_OUTPUTS = new Set(['app/routeTree.gen.ts']);
/** The Build Output config `vite build` writes and `cf deploy --prebuilt` ships. */
export const BUILT_WORKER_CONFIG_PATH = '.cloudflare/output/v0/workers/default/worker.config.json';

/**
 * @typedef {(command: string, args: readonly string[], options: {stdio: 'inherit'}) => {
 *   error?: Error;
 *   status?: number | null;
 * }} DeploySpawn
 */

export function validateOAuthClientId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${CLIENT_ID_ENV} must be configured as a non-secret deploy environment variable.`);
  }
  if (value.length > MAX_CLIENT_ID_LENGTH) {
    throw new Error(`${CLIENT_ID_ENV} must be at most ${MAX_CLIENT_ID_LENGTH} characters.`);
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error(`${CLIENT_ID_ENV} may contain only letters, digits, dots, underscores, tildes, and hyphens.`);
  }
  return value;
}

export function validateCommitSha(value) {
  if (typeof value !== 'string' || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error('The production commit SHA must be the exact lowercase 40-hex Git commit ID.');
  }
  return value;
}

/**
 * @param {{spawn?: typeof spawnSync}} [options]
 */
export function resolveCurrentCommitSha({ spawn = spawnSync } = {}) {
  const result = spawn('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`Unable to resolve the current Git commit${detail ? `: ${detail}` : '.'}`);
  }
  return validateCommitSha(typeof result.stdout === 'string' ? result.stdout.trim() : '');
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   spawn?: typeof spawnSync;
 *   currentCommitSha?: string;
 * }} [options]
 */
export function validateWorkersBuildContext({ env = process.env, spawn = spawnSync, currentCommitSha } = {}) {
  const { branch, commitSha } = validateWorkersBuildMetadata({ env, spawn, currentCommitSha });
  if (branch !== 'main') {
    throw new Error(`Cloudflare production deploy requires the main branch; found ${branch}.`);
  }
  return commitSha;
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   spawn?: typeof spawnSync;
 *   currentCommitSha?: string;
 * }} [options]
 */
export function validateWorkersBuildMetadata({ env = process.env, spawn = spawnSync, currentCommitSha } = {}) {
  if (env.WORKERS_CI !== '1') {
    throw new Error('Cloudflare Workers Builds requires WORKERS_CI=1.');
  }
  const branch = env.WORKERS_CI_BRANCH;
  if (
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(branch)
  ) {
    throw new Error('WORKERS_CI_BRANCH must be a non-empty Git branch name without control characters.');
  }
  const buildCommitSha = validateCommitSha(env.WORKERS_CI_COMMIT_SHA);
  const checkoutCommitSha = currentCommitSha ?? resolveCurrentCommitSha({ spawn });
  if (buildCommitSha !== checkoutCommitSha) {
    throw new Error(
      `Workers Builds commit ${buildCommitSha} does not match the checked-out commit ${checkoutCommitSha}.`,
    );
  }
  if (typeof env.WORKERS_CI_BUILD_UUID !== 'string' || !WORKERS_BUILD_UUID_PATTERN.test(env.WORKERS_CI_BUILD_UUID)) {
    throw new Error('WORKERS_CI_BUILD_UUID must be a lowercase UUID.');
  }
  return { branch, commitSha: buildCommitSha };
}

/**
 * Validation regenerates the checked-in route tree using the pinned toolchain.
 * Permit only ordinary modifications to that exact path;
 * every other tracked or untracked change still fails closed.
 */
export function findUnexpectedDeployChanges(status, { workersBuild = false } = {}) {
  if (typeof status !== 'string' || status.trim().length === 0) {
    return [];
  }
  return status
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      if (!workersBuild) {
        return true;
      }
      const state = line.slice(0, 2);
      const path = line.slice(3);
      return !(/^[ M]{2}$/.test(state) && state.includes('M') && WORKERS_BUILD_GENERATED_OUTPUTS.has(path));
    });
}

/**
 * Resolve a commit that exactly describes the files being deployed. Tracked or
 * untracked changes would make COMMIT_SHA misleading, so production fails closed.
 * @param {{spawn?: typeof spawnSync, env?: Record<string, string | undefined>}} [options]
 */
export function resolveDeployableCommitSha({ spawn = spawnSync, env = process.env } = {}) {
  const commitSha = resolveCurrentCommitSha({ spawn });
  validateWorkersBuildContext({ env, spawn, currentCommitSha: commitSha });
  requireDeployableWorktree({ spawn, env });
  return commitSha;
}

/**
 * The last command of every Workers Builds build step. On main it proves the inputs the deploy step will release.
 * Any other branch deploys nothing (scripts/workers-builds-branch.mjs), so it proves the same build identity and
 * clean checkout without the production-branch requirement, which every deploy path still enforces itself.
 * @param {{clientId?: string, env?: Record<string, string | undefined>, spawn?: typeof spawnSync}} [options]
 * @returns {string} the commit the build checked
 */
export function checkWorkersBuildInputs({
  clientId = process.env[CLIENT_ID_ENV],
  env = process.env,
  spawn = spawnSync,
} = {}) {
  validateOAuthClientId(clientId);
  if (env.WORKERS_CI_BRANCH === 'main') {
    return resolveDeployableCommitSha({ spawn, env });
  }
  const { commitSha } = validateWorkersBuildMetadata({ env, spawn });
  requireDeployableWorktree({ spawn, env });
  return commitSha;
}

/**
 * @param {{spawn: typeof spawnSync, env: Record<string, string | undefined>}} options
 */
function requireDeployableWorktree({ spawn, env }) {
  const result = spawn('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`Unable to verify the production worktree${detail ? `: ${detail}` : '.'}`);
  }
  const unexpectedChanges = findUnexpectedDeployChanges(result.stdout, { workersBuild: env.WORKERS_CI === '1' });
  if (unexpectedChanges.length > 0) {
    throw new Error(
      `Production deploy requires a clean Git worktree so COMMIT_SHA exactly identifies the build. Unexpected changes: ${unexpectedChanges.join(', ')}`,
    );
  }
  const ignoredEnvironmentFiles = spawn(
    'git',
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      ':(top).env',
      ':(top).env.*',
      ':(top).dev.vars',
      ':(top).dev.vars*',
      ':(top)*.vars',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (ignoredEnvironmentFiles.error) {
    throw ignoredEnvironmentFiles.error;
  }
  if (ignoredEnvironmentFiles.status !== 0) {
    const detail = typeof ignoredEnvironmentFiles.stderr === 'string' ? ignoredEnvironmentFiles.stderr.trim() : '';
    throw new Error(`Unable to inspect ignored production environment files${detail ? `: ${detail}` : '.'}`);
  }
  if (typeof ignoredEnvironmentFiles.stdout !== 'string' || ignoredEnvironmentFiles.stdout.length > 0) {
    throw new Error(
      'Production deploy refuses ignored root .env*, .dev.vars*, and *.vars files because Vite or cf could make the build differ from COMMIT_SHA.',
    );
  }
}

/**
 * cloudflare.config.ts binds COMMIT_SHA and the OAuth client id from the environment of the build, so the deploy
 * tooling builds with exactly these values and ships that build output; neither value is ever committed.
 * @param {string | undefined} clientId
 * @param {string} commitSha
 * @param {Record<string, string | undefined>} [env]
 */
export function deployVarsEnv(clientId, commitSha, env = process.env) {
  return { ...env, COMMIT_SHA: validateCommitSha(commitSha), [CLIENT_ID_ENV]: validateOAuthClientId(clientId) };
}

/**
 * @param {(path: string) => string} [readBuiltConfig]
 * @returns {{COMMIT_SHA?: string, CLOUDFLARE_OAUTH_CLIENT_ID?: string}}
 */
export function readBuiltDeployVars(readBuiltConfig = (path) => readFileSync(path, 'utf8')) {
  const config = JSON.parse(readBuiltConfig(BUILT_WORKER_CONFIG_PATH));
  const textValue = (name) => {
    const binding = config?.env?.[name];
    return binding?.type === 'text' ? binding.value : undefined;
  };
  return { COMMIT_SHA: textValue('COMMIT_SHA'), [CLIENT_ID_ENV]: textValue(CLIENT_ID_ENV) };
}

/**
 * Fail closed unless the build output carries exactly the commit and OAuth client id being released.
 * @param {string | undefined} clientId
 * @param {string} commitSha
 * @param {(path: string) => string} [readBuiltConfig]
 */
export function verifyBuiltDeployVars(clientId, commitSha, readBuiltConfig) {
  const built = readBuiltDeployVars(readBuiltConfig);
  if (built.COMMIT_SHA !== validateCommitSha(commitSha)) {
    throw new Error(`${BUILT_WORKER_CONFIG_PATH} must bind COMMIT_SHA to ${commitSha}; found ${built.COMMIT_SHA}.`);
  }
  if (built[CLIENT_ID_ENV] !== validateOAuthClientId(clientId)) {
    throw new Error(`${BUILT_WORKER_CONFIG_PATH} must bind ${CLIENT_ID_ENV} to the deploy environment's value.`);
  }
}

/**
 * @param {DeploySpawn} spawn
 * @param {readonly string[]} args
 * @param {Record<string, unknown>} options
 * @param {string} label
 * @param {string} [failureSuffix]
 */
function runPnpmStep(spawn, args, options, label, failureSuffix = '') {
  const result = spawn('pnpm', args, options);
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status !== 'number') {
    throw new Error(`${label} terminated without an exit status.`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit status ${result.status}.${failureSuffix}`);
  }
}

export const CF_DEPLOY_ARGS = Object.freeze(['exec', 'cf', 'deploy', '--prebuilt']);

/**
 * The Workers Builds deploy step's checks, in order: the account resources are what this release
 * expects, then a D1 restore point is recorded before the migrations it protects. Each one must pass
 * before anything is deployed. The committed-config checks (`verify:production-config`,
 * `verify:workers-builds-config`) are not repeated here: they are part of `pnpm run validate`, which
 * every step after the account check waits for.
 */
export const WORKERS_BUILDS_PRE_DEPLOY_STEPS = Object.freeze([
  'provision:production:check',
  'd1:bookmark:production',
  'd1:migrations:apply:production',
]);

const D1_MIGRATIONS_STEP = 'd1:migrations:apply:production';
const MIGRATIONS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const RESTORE_POINT_IN_LOG = `the bookmark is in this build's log, under "Pre-migration D1 restore point" (and the ${D1_RESTORE_RECEIPT_MARKER} line), with its restore command`;

/**
 * The newest control-plane migration in this checkout, which is the last one applied once
 * `d1:migrations:apply:production` succeeds, since it applies every pending one in order.
 * @param {(path: string) => string[]} [listMigrations]
 * @returns {string | null}
 */
export function latestControlPlaneMigration(listMigrations = (path) => readdirSync(path)) {
  return (
    listMigrations(MIGRATIONS_DIRECTORY)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .at(-1) ?? null
  );
}

/**
 * What a failure after the migrations must also say: production D1 is already on the new schema
 * whether or not this release's Worker is live, and where its pre-migration restore point is.
 * @param {string | null} latestMigration
 */
export function migratedD1Note(latestMigration) {
  const through = latestMigration ? ` through ${latestMigration}` : '';
  return ` Control-plane D1 was already migrated${through}; ${RESTORE_POINT_IN_LOG}. See "Failed release after migrations" in DEVELOPMENT.md before restoring.`;
}

/** What a failure of the migrations themselves must also say. */
export const PARTIALLY_MIGRATED_D1_NOTE = ` Control-plane D1 may be partially migrated; ${RESTORE_POINT_IN_LOG}. See "Failed release after migrations" in DEVELOPMENT.md.`;

/**
 * The pre-deploy steps that change production data. They wait for the validation gate, so a release that
 * fails validation migrates nothing, and the restore point is recorded as late as possible before them.
 */
export const WORKERS_BUILDS_AFTER_VALIDATION_STEPS = Object.freeze([
  'd1:bookmark:production',
  'd1:migrations:apply:production',
]);

/**
 * The release's validation gate. Its `build:check` is the same `vite build` the release ships, so running
 * it with the deploy vars builds the Worker and proves it (tests, types, lint, built-output checks) in one pass.
 */
const WORKERS_BUILDS_VALIDATE_ARGS = Object.freeze(['run', 'validate']);

/**
 * @typedef {(command: string, args: readonly string[], options: Record<string, unknown>) => Promise<{
 *   status: number | null;
 *   output: string;
 * }>} BufferedSpawn
 */

/**
 * Output goes to a file rather than a pipe: the checks beside it run synchronously and block this
 * process's event loop, and a pipe nobody drains would stall the build as soon as it filled.
 * @type {BufferedSpawn}
 */
function spawnBuffered(command, args, options) {
  const directory = mkdtempSync(join(tmpdir(), 'cloudchef-build-'));
  const logPath = join(directory, 'build.log');
  const fd = openSync(logPath, 'w');
  const read = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return new Promise((resolveRun, reject) => {
    const child = spawnAsync(command, args, { ...options, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    child.once('error', (error) => {
      read();
      reject(error);
    });
    child.once('close', (status) => resolveRun({ status, output: read() }));
  });
}

/**
 * The Workers Builds deploy step. The release's validation gate, `pnpm run validate`, runs with the
 * release's deploy vars, so the Worker its `build:check` builds and its built-output checks prove is the
 * one `cf deploy` ships. The checks that read only the account and the committed config run meanwhile;
 * the D1 restore point and migrations wait for validation to pass, and `cf deploy` waits for everything.
 * A failed check, validation, or migration therefore deploys nothing, and failed validation migrates
 * nothing. A failure from the migrations on says that D1 was (or may have been partly) migrated and
 * where the restore point is, since the Worker serving traffic may now predate the schema. Validation's output is printed in one piece when it finishes, so it never interleaves with
 * the checks' output.
 *
 * @param {{
 *   clientId?: string;
 *   env?: Record<string, string | undefined>;
 *   spawn?: DeploySpawn;
 *   spawnValidation?: BufferedSpawn;
 *   readBuiltConfig?: (path: string) => string;
 *   verifyLocal?: typeof verifyLocalDeployment;
 *   log?: (text: string) => void;
 *   latestMigration?: () => string | null;
 * }} [options]
 */
export async function deployFromWorkersBuilds({
  clientId = process.env[CLIENT_ID_ENV],
  env = process.env,
  spawn = spawnSync,
  spawnValidation = spawnBuffered,
  readBuiltConfig,
  verifyLocal = verifyLocalDeployment,
  log = (text) => process.stdout.write(text),
  latestMigration = () => latestControlPlaneMigration(),
} = {}) {
  validateOAuthClientId(clientId);
  const commitSha = resolveDeployableCommitSha({ spawn, env });
  const nothingDeployed = ' Nothing was deployed.';
  const settled = spawnValidation('pnpm', WORKERS_BUILDS_VALIDATE_ARGS, {
    env: deployVarsEnv(clientId, commitSha, env),
  }).then(
    (result) => ({ result, error: undefined }),
    (error) => ({ result: undefined, error }),
  );
  const validated = settled.then(({ result, error }) => {
    if (result) {
      log(result.output);
    }
    if (error) {
      throw error;
    }
    if (result?.status !== 0) {
      throw new Error(`Validation failed with exit status ${result?.status}.${nothingDeployed} Nothing was migrated.`);
    }
    // Validation regenerates the checked-in outputs, so prove the build is still exactly this commit.
    resolveDeployableCommitSha({ spawn, env });
  });
  // Observed here so a check that fails first never leaves validation's rejection unhandled.
  validated.catch(() => undefined);
  try {
    for (const step of WORKERS_BUILDS_PRE_DEPLOY_STEPS) {
      if (WORKERS_BUILDS_AFTER_VALIDATION_STEPS.includes(step)) {
        await validated;
      }
      const failureSuffix =
        step === D1_MIGRATIONS_STEP ? `${nothingDeployed}${PARTIALLY_MIGRATED_D1_NOTE}` : nothingDeployed;
      runPnpmStep(spawn, ['run', step], { stdio: 'inherit', env }, step, failureSuffix);
    }
    await validated;
  } catch (error) {
    // Validation's output belongs to this build's log even when a check failed first.
    await settled;
    throw error;
  }
  // From here on production D1 is on this release's schema, so every failure says so.
  try {
    verifyBuiltDeployVars(clientId, commitSha, readBuiltConfig);
    runPnpmStep(
      spawn,
      CF_DEPLOY_ARGS,
      { stdio: 'inherit', env: deployVarsEnv(clientId, commitSha, env) },
      'cf deploy',
      ' Live verification was not run.',
    );
    await verifyLocal({ expectedSha: commitSha });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${migratedD1Note(latestMigration())}`, { cause: error });
  }
  return commitSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const main = async () => {
    const [command, ...extraArgs] = process.argv.slice(2);
    const allowed = new Set(['--check-workers-builds', '--workers-builds']);
    if (extraArgs.length > 0 || !allowed.has(command)) {
      throw new Error('Usage: node scripts/deploy-production.mjs --check-workers-builds | --workers-builds');
    }
    if (command === '--workers-builds') {
      await deployFromWorkersBuilds();
      return;
    }
    const commitSha = checkWorkersBuildInputs();
    console.log(
      process.env.WORKERS_CI_BRANCH === 'main'
        ? `Production deploy inputs are valid for commit ${commitSha}.`
        : `Branch build inputs are valid for commit ${commitSha}; a branch build deploys nothing.`,
    );
  };

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
