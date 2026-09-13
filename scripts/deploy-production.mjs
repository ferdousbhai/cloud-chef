import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyLocalDeployment } from './verify-live-deployment.mjs';

const CLIENT_ID_ENV = 'CLOUDFLARE_OAUTH_CLIENT_ID';
const MAX_CLIENT_ID_LENGTH = 512;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKERS_BUILD_UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WORKERS_BUILD_GENERATED_OUTPUTS = new Set(['app/routeTree.gen.ts']);

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
 * Assert a local checkout describes exactly what is about to ship: on the
 * production branch, and identical to the pushed commit. Workers Builds proves
 * this from its own metadata; a workstation has to prove it from the remote.
 * @param {{spawn?: DeploySpawn, currentCommitSha?: string}} [options]
 */
export function validateLocalDeployContext({ spawn = spawnSync, currentCommitSha } = {}) {
  const branch = runGit(spawn, ['rev-parse', '--abbrev-ref', 'HEAD'], 'resolve the current branch');
  if (branch !== 'main') {
    throw new Error(`Local production deploy requires the main branch; found ${branch}.`);
  }
  const remoteSha = runGit(spawn, ['rev-parse', '--verify', 'origin/main^{commit}'], 'resolve origin/main');
  const commitSha = currentCommitSha ?? resolveCurrentCommitSha({ spawn });
  if (remoteSha !== commitSha) {
    throw new Error(
      `Local production deploy requires an already-pushed commit; origin/main is ${remoteSha} but HEAD is ${commitSha}.`,
    );
  }
  return commitSha;
}

/**
 * @param {DeploySpawn} spawn
 * @param {readonly string[]} args
 * @param {string} purpose
 * @returns {string}
 */
function runGit(spawn, args, purpose) {
  const result = spawn('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`Unable to ${purpose}${detail ? `: ${detail}` : '.'}`);
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/**
 * Resolve a commit that exactly describes the files being deployed. Tracked or
 * untracked changes would make COMMIT_SHA misleading, so production fails closed.
 * @param {{spawn?: typeof spawnSync, env?: Record<string, string | undefined>, local?: boolean}} [options]
 */
export function resolveDeployableCommitSha({ spawn = spawnSync, env = process.env, local = false } = {}) {
  const commitSha = resolveCurrentCommitSha({ spawn });
  if (local) {
    validateLocalDeployContext({ spawn, currentCommitSha: commitSha });
  } else {
    validateWorkersBuildContext({ env, spawn, currentCommitSha: commitSha });
  }
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
      'Production deploy refuses ignored root .env*, .dev.vars*, and *.vars files because Vite or Wrangler could make the build differ from COMMIT_SHA.',
    );
  }
  return commitSha;
}

export function wranglerDeployArgs(clientId, commitSha) {
  return [
    'exec',
    'wrangler',
    'deploy',
    '--var',
    `COMMIT_SHA:${validateCommitSha(commitSha)}`,
    '--var',
    `${CLIENT_ID_ENV}:${validateOAuthClientId(clientId)}`,
  ];
}

/**
 * @param {{
 *   clientId?: string;
 *   commitSha?: string;
 *   env?: Record<string, string | undefined>;
 *   spawn?: DeploySpawn;
 *   local?: boolean;
 * }} [options]
 */
export function deployProduction({
  clientId = process.env[CLIENT_ID_ENV],
  commitSha,
  env = process.env,
  spawn = spawnSync,
  local = false,
} = {}) {
  commitSha =
    commitSha === undefined
      ? resolveDeployableCommitSha({ spawn, env, local })
      : local
        ? validateLocalDeployContext({ spawn, currentCommitSha: validateCommitSha(commitSha) })
        : validateWorkersBuildContext({ env, spawn, currentCommitSha: validateCommitSha(commitSha) });
  const args = wranglerDeployArgs(clientId, commitSha);
  const result = spawn('pnpm', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status !== 'number') {
    throw new Error('Wrangler deploy terminated without an exit status.');
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler deploy failed with exit status ${result.status}. Live verification was not run.`);
  }
  return validateCommitSha(commitSha);
}

/**
 * @param {{
 *   clientId?: string;
 *   commitSha?: string;
 *   env?: Record<string, string | undefined>;
 *   spawn?: DeploySpawn;
 *   local?: boolean;
 *   verifyLocal?: typeof verifyLocalDeployment;
 * }} [options]
 */
export async function deployAndVerifyProduction({
  clientId = process.env[CLIENT_ID_ENV],
  commitSha,
  env = process.env,
  spawn = spawnSync,
  local = false,
  verifyLocal = verifyLocalDeployment,
} = {}) {
  const deployedSha = deployProduction({ clientId, commitSha, env, spawn, local });
  await verifyLocal({ expectedSha: deployedSha });
  return deployedSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const main = async () => {
    const [command, ...extraArgs] = process.argv.slice(2);
    const allowed = new Set([undefined, '--check-workers-builds', '--local']);
    if (extraArgs.length > 0 || !allowed.has(command)) {
      throw new Error('Usage: node scripts/deploy-production.mjs [--check-workers-builds | --local]');
    }
    const local = command === '--local';
    const clientId = validateOAuthClientId(process.env[CLIENT_ID_ENV]);
    const commitSha = resolveDeployableCommitSha({ local });
    if (command === '--check-workers-builds') {
      console.log(`Production deploy inputs are valid for commit ${commitSha}.`);
      return;
    }
    await deployAndVerifyProduction({ clientId, commitSha, local });
  };

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
