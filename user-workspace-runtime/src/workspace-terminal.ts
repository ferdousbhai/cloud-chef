import { CONTAINER_TOOL_ENV } from './computer-sandbox';
import { CONTAINER_PNPM_STORE_DIR } from './container-toolchain';
import { shellQuote } from './shell-quote';

/**
 * The terminal's home folder. Everything under /home is kept with the workspace, so what a person signs in to
 * there (a coding agent's login, `gh auth`, their own ~/.gitconfig) is still there after the container restarts.
 * It sits beside the project, never in it, so it is not part of the project's files, checkpoints or limits; it
 * does take room in the workspace's own storage, which is why caches and installed tools are kept off it below.
 */
export const TERMINAL_HOME = '/home/user';

/** The container's own disk, wiped on every restart: where caches and installed tools go instead. */
const CONTAINER_HOME = '/root';

const TERMINAL_HOME_NOTE = `Your home folder, ${TERMINAL_HOME}, is kept with this workspace: sign-ins and settings saved there stay after a restart. Installed tools and caches don't.`;

/**
 * Downloads and installs that would otherwise land in the kept home: caches, npm's and pnpm's stores, and
 * per-user installs (XDG data and state, where installers such as Claude Code's put their binaries). Logins
 * stay: they live in the home itself or under ~/.config. git needs nothing here: the workspace's git wrapper
 * keeps the project's identity and hooks in the project's own history, which ~/.gitconfig only adds to.
 */
export function terminalEnvironment() {
  return {
    ...CONTAINER_TOOL_ENV,
    TERM: 'xterm-256color',
    HOME: TERMINAL_HOME,
    XDG_CACHE_HOME: `${CONTAINER_HOME}/.cache`,
    XDG_DATA_HOME: `${CONTAINER_HOME}/.local/share`,
    XDG_STATE_HOME: `${CONTAINER_HOME}/.local/state`,
    npm_config_cache: `${CONTAINER_HOME}/.npm`,
    npm_config_store_dir: CONTAINER_PNPM_STORE_DIR,
    PNPM_HOME: `${CONTAINER_HOME}/.local/share/pnpm`,
  };
}

/** A login shell (started in the project folder, its `cwd`), creating the home the first time with a one-line note about it. */
export function terminalCommand() {
  const home = shellQuote(TERMINAL_HOME);
  return [
    '/bin/bash',
    '-c',
    [
      `if [ ! -d ${home} ]; then mkdir -p ${home} && printf '%s\\n\\n' ${shellQuote(TERMINAL_HOME_NOTE)}; fi`,
      'exec /bin/bash -l',
    ].join('\n'),
  ] as const;
}
