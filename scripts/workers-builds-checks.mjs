import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * What a Workers Builds build runs before its deploy step. A branch build runs the full validation, so
 * a change is proven before it reaches the production branch. The production branch only regenerates the
 * checked-in outputs: the change was validated on its branch (or locally) already, and the deploy step
 * builds and verifies the Worker itself, which keeps a release to a couple of minutes.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {readonly string[]} the pnpm script to run
 */
export function workersBuildsChecks({ env = process.env } = {}) {
  return env.WORKERS_CI_BRANCH === 'main' ? ['run', 'generate'] : ['run', 'validate'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = workersBuildsChecks();
  console.log(
    `Workers Builds checks for ${process.env.WORKERS_CI_BRANCH ?? 'an unknown branch'}: pnpm ${args.join(' ')}`,
  );
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
