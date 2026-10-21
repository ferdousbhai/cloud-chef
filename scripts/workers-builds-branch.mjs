import { pathToFileURL } from 'node:url';

/**
 * The deploy step of a Workers Builds branch (non-production) build: nothing. The build step already
 * ran the full validation (scripts/workers-builds-checks.mjs). A branch build never uploads a version
 * of the `cloudchef` Worker: every version carries production's D1 binding and secrets, so one built
 * from an unreviewed branch must not exist, let alone answer at a preview URL.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {string} what the step reports
 */
export function workersBuildsBranch({ env = process.env } = {}) {
  const branch = env.WORKERS_CI_BRANCH;
  if (!branch) {
    throw new Error('The Workers Builds branch step runs only in Workers Builds.');
  }
  if (branch === 'main') {
    throw new Error('The production branch deploys with pnpm run workers-builds:deploy.');
  }
  return `Validated ${branch}. Branch builds upload no Worker version.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(workersBuildsBranch());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
