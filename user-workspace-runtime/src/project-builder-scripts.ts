import { GIT_PROXY_HOST } from '../../app/lib/.server/cloudflare/git-proxy';
import { shellQuote } from './shell-quote';

/** The build container's shell scripts (`ProjectBuilder`), apart so they can be run for real in tests. */

export const WORK_DIR = '/work';
export const BUILD_USER = 'build';
export const BUILD_UID = 1001;

/** `command`, run in the work folder as the unprivileged build user, with nothing of root's environment. */
export function asBuildUserCommand(command: string): string {
  return (
    `setpriv --reuid=${BUILD_UID} --regid=${BUILD_UID} --clear-groups --no-new-privs -- ` +
    `env -i HOME=/home/${BUILD_USER} PATH=/usr/local/bin:/usr/bin:/bin CI=1 ` +
    `sh -c ${shellQuote(`cd ${WORK_DIR} && ${command}`)}`
  );
}

/** Fetches exactly the commit into the work folder, through the read-only source proxy. */
export function fetchCommand(job: { commit: string; branch: string }): string {
  const remote = `http://${GIT_PROXY_HOST}/project.git`;
  return [
    'set -e',
    'git init -q .',
    `git fetch -q --depth=1 ${remote} ${job.commit} 2>/dev/null ||`,
    `  git fetch -q --depth=1 ${remote} ${shellQuote(job.branch)}`,
    `[ "$(git rev-parse FETCH_HEAD)" = ${job.commit} ] || { echo 'The branch moved on since this commit.' >&2; exit 1; }`,
    'git checkout -q FETCH_HEAD',
  ].join('\n');
}

/**
 * Stops every process the build left, checks none is left, removes the history and local secrets (they never go to
 * Cloudflare, and Wrangler would read them), and takes the files away from the build user. Run by bash, as root.
 */
export function endBuildPhase(): string {
  return [
    'set -eu',
    `pkill -KILL -u ${BUILD_USER} || true`,
    'sleep 1',
    `if pgrep -u ${BUILD_USER} >/dev/null; then echo 'The build left processes running.' >&2; exit 1; fi`,
    `rm -rf ${WORK_DIR}/.git`,
    // A link out of the project would let the deploy read, and upload, a file of the container's.
    `find ${WORK_DIR} -type l -print0 | while IFS= read -r -d '' link; do case "$(realpath -m -- "$link")" in ${WORK_DIR}/*) ;; *) rm -f -- "$link" ;; esac; done`,
    `find ${WORK_DIR} -name node_modules -prune -o \\( -name '.env' -o -name '.env.*' -o -name '.dev.vars' -o -name '.dev.vars.*' \\) -print0 | xargs -0 rm -rf --`,
    `chown -R root:root ${WORK_DIR}`,
  ].join('\n');
}
