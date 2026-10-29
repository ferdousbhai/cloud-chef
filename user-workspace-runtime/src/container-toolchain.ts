import { GENERATED_PROJECT_PNPM_VERSION } from '../../cloudchef-agent/cloudflare-computer';
import { VALIDATE_COMMAND, WORK_DIR } from '../../cloudchef-agent/constants';
import templatePackage from '../../template/package.json' with { type: 'json' };
import { CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS } from './operation-lease-policy';
import { shellQuote } from './shell-quote';
import { abortableSleep } from '../../app/lib/abortable-sleep';
import { GIT_BASE_PATH, GIT_PROXY_HOST } from '../../app/lib/.server/cloudflare/git-proxy';
import {
  CLOUDFLARE_API_PROXY_BASE_URL,
  CLOUDFLARE_API_PROXY_TOKEN,
} from '../../app/lib/.server/cloudflare/cloudflare-api-proxy';
import { ZERO_OID } from '../../app/lib/.server/cloudflare/repository-wire';

/**
 * One content-addressed pnpm store for every install this container runs. Passed explicitly on the
 * install command rather than left to config discovery, so every install lands on the same store
 * and a second install in the same container reuses the first one's downloads.
 */
export const CONTAINER_PNPM_STORE_DIR = '/opt/cloudchef/pnpm-store';

/**
 * The toolchain bootstrap writes the git wrapper, its hooks and the `cf` launcher into a container
 * whose image already carries pnpm and cf at their pins. It installs pnpm only when an image lacks
 * the pinned version, which is a network package installation into the same container the project's
 * own installs run in, so it shares their ceiling rather than declaring another number (#131).
 */
export const CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS = CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS;

/**
 * Health probing, POST /connect, and the /api upgrade that follow the container start. computerd is
 * the image's entrypoint, so nothing is downloaded before it answers.
 */
const CONTAINER_CONNECT_STAGES_MARGIN_MS = 2 * 60_000;

/**
 * @cloudflare/computer's LegacyContainerBackend arms its whole connect deadline before calling
 * `host.start()`, and the toolchain bootstrap runs inside that start, so both spend from this same
 * budget. Derive it as the sum of the stages it must cover, so the vendor deadline cannot silently
 * undercut a stage budget declared here (the #127 guard shape, pinned by test).
 */
export const CONTAINER_CONNECT_TIMEOUT_MS =
  CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS + CONTAINER_CONNECT_STAGES_MARGIN_MS;

/** Pacing between bootstrap attempts, not a ceiling: the stage budget is. */
export const BOOTSTRAP_RETRY_DELAY_MS = 5_000;

/** An interrupted bootstrap names itself instead of surfacing as a bare vendor abort (#131). */
export class ContainerToolchainBootstrapError extends Error {
  constructor(
    readonly stage: string,
    budgetMs: number,
    attempts: number,
    cause: Error,
  ) {
    super(
      `The container ${stage} bootstrap did not complete within its ${Math.round(budgetMs / 1_000)}s budget ` +
        `(${attempts} attempt${attempts === 1 ? '' : 's'}): ${cause.message} ` +
        `The bootstrap is idempotent and the workspace retries it automatically.`,
      { cause },
    );
    this.name = 'ContainerToolchainBootstrapError';
  }
}

/**
 * Run one bootstrap stage until it succeeds or its budget is spent.
 *
 * The bootstrap command is idempotent by construction — it installs only when
 * the pinned version is absent and rewrites the same files — so retrying after
 * any failure is safe. The failure this exists for is an exec that reaches a
 * container still starting; without a retry it became a durable dead end for
 * the workspace (#131).
 */
export async function runIdempotentBootstrapStage(options: {
  stage: string;
  budgetMs: number;
  attempt: (remainingMs: number) => Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + options.budgetMs;
  let attempts = 0;
  // Assigned on every path that reaches the throw: the loop body either
  // returns from a successful attempt or records the failure first.
  let lastError!: Error;
  do {
    attempts += 1;
    try {
      await options.attempt(Math.max(1, deadline - Date.now()));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (deadline - Date.now() <= BOOTSTRAP_RETRY_DELAY_MS) {
      break;
    }
    await abortableSleep(BOOTSTRAP_RETRY_DELAY_MS);
  } while (Date.now() < deadline);
  throw new ContainerToolchainBootstrapError(options.stage, options.budgetMs, attempts, lastError);
}

/** The generated project's own pinned `cf`, so the model plans with the CLI the project builds with. */
export const CF_CLI_VERSION = templatePackage.devDependencies.cf;
const CF_CLI_ROOT = '/opt/cloudchef/cf';
export const CF_CLI_WRAPPER = '/usr/local/bin/cf';
const CLOUDCHEF_COMMAND = '/usr/local/bin/cloudchef';

/**
 * Install pnpm, a `cf` launcher and the `cloudchef` command, in one bootstrap stage.
 *
 * The container holds no Cloudflare credential: `cf` sends its API requests to the runtime's
 * CloudflareApiProxy, which adds the account's authorization outside the container, sends reads, and
 * holds each change for the person's approval. The account id makes `cf` act on the connected account.
 * The launcher runs the project's own pinned `cf` once dependencies are installed, and otherwise
 * fetches the same pin on first use, without the optional local simulator nothing here runs. Concurrent
 * first uses each stage their own install and the first rename wins.
 */
export function containerToolchainBootstrapCommand(accountId: string): string {
  const expectedVersion = shellQuote(GENERATED_PROJECT_PNPM_VERSION);
  return strictSubshellCommand([
    `if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version)" != ${expectedVersion} ]; then`,
    `  npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION} --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/`,
    'fi',
    `test "$(pnpm --version)" = ${expectedVersion}`,
    `printf %s ${shellQuote(cfCliLauncherScript(accountId))} > ${shellQuote(CF_CLI_WRAPPER)}`,
    `chmod 0755 ${shellQuote(CF_CLI_WRAPPER)}`,
    `printf %s ${shellQuote(cloudchefCommandScript())} > ${shellQuote(CLOUDCHEF_COMMAND)}`,
    `chmod 0755 ${shellQuote(CLOUDCHEF_COMMAND)}`,
    `test -x ${shellQuote(REAL_GIT)}`,
    `mkdir -p ${shellQuote(GIT_HOOKS)}`,
    ...[
      [GIT_WRAPPER, gitWrapperScript()],
      [GIT_SETUP, gitSetupScript()],
      [`${GIT_HOOKS}/pre-commit`, gitPreCommitHook()],
      [`${GIT_HOOKS}/pre-push`, gitPrePushHook()],
      ...GIT_SAVE_HOOKS.map((hook) => [`${GIT_HOOKS}/${hook}`, gitSaveHook()]),
    ].flatMap(([path, script]) => [
      `printf %s ${shellQuote(script)} > ${shellQuote(path)}`,
      `chmod 0755 ${shellQuote(path)}`,
    ]),
  ]);
}

/**
 * git for the project. Its history lives on the container's own disk, outside `/home`, which the
 * workspace stores durably whole: the project's files are kept, and a new container sets up the history
 * again from the project's repository on first use, with the branches the save hook kept there. The remote
 * is the runtime's git proxy, so nothing here holds a credential.
 */
const GIT_WRAPPER = '/usr/local/bin/git';
const REAL_GIT = '/usr/bin/git';
const GIT_ROOT = '/opt/cloudchef/git';
const GIT_DIR = `${GIT_ROOT}/project.git`;
const GIT_SETUP = `${GIT_ROOT}/setup`;
const GIT_HOOKS = `${GIT_ROOT}/hooks`;
const GIT_REMOTE = `http://${GIT_PROXY_HOST}/project.git`;
/** `.env`, `.env.*` and `.dev.vars`, `.dev.vars.*` at any depth, as files git refuses to save. */
const SECRET_FILE_PATTERN = '(^|/)(\\.env|\\.dev\\.vars)(\\.[^/]*)?$';
const SECRET_EXAMPLE_PATTERN = '(^|/)\\.env\\.(example|sample|template)$';
const SECRETS_ADVICE =
  "Secrets belong in Cloudflare (the Worker's secrets or Secrets Store, set with cf), never in the project's files.";

/**
 * Inside the project, git uses the project's history and sets it up first when the container has none. A
 * directory with its own `.git`, such as a repository cloned for reference, is left to plain git.
 *
 * After a push, the branch and commit checked out are told to the git proxy when the repository holds that
 * commit: it is where git in the next container starts, so the files there show no changes it didn't make.
 */
export function gitWrapperScript(): string {
  const real = shellQuote(REAL_GIT);
  return [
    '#!/bin/sh',
    'case "$PWD/" in',
    `  ${WORK_DIR}/*)`,
    '    if [ -z "${GIT_DIR:-}" ] && [ ! -e "$PWD/.git" ]; then',
    `      export GIT_DIR=${shellQuote(GIT_DIR)} GIT_WORK_TREE=${shellQuote(WORK_DIR)}`,
    `      [ -f "$GIT_DIR/HEAD" ] || ${shellQuote(GIT_SETUP)} || exit 1`,
    '      if [ "${1:-}" = push ]; then',
    `        ${real} "$@"`,
    '        status=$?',
    '        if [ "$status" -eq 0 ]; then',
    `          branch="$(${real} symbolic-ref -q --short HEAD 2>/dev/null)"`,
    `          commit="$(${real} rev-parse -q --verify HEAD 2>/dev/null)"`,
    `          if [ -n "$branch" ] && [ -n "$commit" ] && [ "$(${real} rev-parse -q --verify "refs/remotes/origin/$branch" 2>/dev/null)" = "$commit" ]; then`,
    `            curl -fsS -o /dev/null -X POST --data-binary "$branch $commit" ${shellQuote(`http://${GIT_PROXY_HOST}${GIT_BASE_PATH}`)} >/dev/null 2>&1 || true`,
    '          fi',
    '        fi',
    '        exit "$status"',
    '      fi',
    '    fi',
    '    ;;',
    'esac',
    `exec ${real} "$@"`,
    '',
  ].join('\n');
}

/**
 * Sets up the project's history once per container, under a lock: fetched through the proxy, with the
 * branches the last container saved (commits not yet pushed among them), and based on the commit the
 * workspace's files match, so `git status` shows exactly what changed since. Only the index is written; the
 * files are already there.
 */
export function gitSetupScript(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `root=${shellQuote(GIT_ROOT)}`,
    'mkdir -p "$root"',
    'exec 9>"$root/.lock"',
    'flock 9',
    `[ -f ${shellQuote(`${GIT_DIR}/HEAD`)} ] && exit 0`,
    'answer="$(mktemp)"',
    `status="$(curl -sS -o "$answer" -w '%{http_code}' ${shellQuote(`http://${GIT_PROXY_HOST}/_cloudchef/workspace`)} || true)"`,
    'if [ "$status" != 200 ]; then',
    '  cat "$answer" >&2 2>/dev/null || true',
    `  echo ${shellQuote('git could not be set up for this project just now. Try again.')} >&2`,
    '  exit 1',
    'fi',
    'base="$(sed -n 1p "$answer")"',
    'branch="${base%% *}"',
    'commit="${base#* }"',
    'name="$(sed -n 2p "$answer")"',
    'email="$(sed -n 3p "$answer")"',
    'saved="$(sed -n 4p "$answer")"',
    '[ -n "$saved" ]',
    'staging="$(mktemp -d "$root/.setup.XXXXXX")"',
    `g() { GIT_DIR="$staging" GIT_WORK_TREE=${shellQuote(WORK_DIR)} ${shellQuote(REAL_GIT)} "$@"; }`,
    'g init -q -b main',
    `g remote add origin ${shellQuote(GIT_REMOTE)}`,
    'g config user.name "$name"',
    'g config user.email "$email"',
    `g config core.hooksPath ${shellQuote(GIT_HOOKS)}`,
    'g config pull.rebase true',
    'g config push.autoSetupRemote true',
    'g config cloudchef.saved "$saved"',
    // The branches the last container saved come back as they were, each following origin's where it has one.
    'g fetch -q origin "+refs/heads/*:refs/remotes/origin/*" "+$saved/*:refs/cloudchef/saved/*"',
    'g for-each-ref --format="%(refname)" refs/cloudchef/saved/ | while read -r ref; do',
    '  name="${ref#refs/cloudchef/saved/}"',
    '  g update-ref "refs/heads/$name" "$ref"',
    '  g update-ref -d "$ref"',
    '  if g rev-parse -q --verify "refs/remotes/origin/$name" >/dev/null; then',
    '    g branch -q --set-upstream-to="origin/$name" "$name"',
    '  fi',
    'done',
    // Where the last container was: its branch, at the commit it reported unless the branch saved since is newer.
    'tip="$(g rev-parse -q --verify "refs/heads/$branch" || true)"',
    'if [ "$commit" != - ] && g cat-file -e "$commit^{commit}" 2>/dev/null && { [ -z "$tip" ] || g merge-base --is-ancestor "$tip" "$commit"; }; then',
    '  start="$commit"',
    'elif [ -n "$tip" ]; then',
    '  start="$tip"',
    'elif start="$(g rev-parse -q --verify "refs/remotes/origin/$branch")"; then',
    '  :',
    'elif start="$(g rev-parse -q --verify refs/heads/main || g rev-parse -q --verify refs/remotes/origin/main)"; then',
    '  branch=main',
    'else',
    '  start=""',
    '  branch=main',
    'fi',
    'g symbolic-ref HEAD "refs/heads/$branch"',
    'if [ -n "$start" ]; then',
    '  g update-ref "refs/heads/$branch" "$start"',
    '  g read-tree HEAD',
    // The workspace keeps only regular files: a symbolic link or submodule the project has is marked as not
    // here, so git doesn't show it as removed and a commit never removes it.
    `  g ls-files -s | while IFS="$(printf '\\t')" read -r meta path; do case "$meta" in 120000*|160000*) printf '%s\\n' "$path";; esac; done | g update-index --skip-worktree --stdin`,
    '  if g rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then',
    '    g branch -q --set-upstream-to="origin/$branch" "$branch"',
    '  fi',
    'fi',
    `printf '%s\\n' ${gitExcludes().map(shellQuote).join(' ')} > "$staging/info/exclude"`,
    `mv -T "$staging" ${shellQuote(GIT_DIR)}`,
    '',
  ].join('\n');
}

/** Never saved, whatever the project's own `.gitignore` says: local secrets and build output. */
function gitExcludes(): string[] {
  return [
    '.env',
    '.env.*',
    '!.env.example',
    '!.env.sample',
    '!.env.template',
    '.dev.vars',
    '.dev.vars.*',
    ...['node_modules', 'dist', '.output', '.tanstack', '.wrangler', '.cloudflare', '.venv'].map((root) => `/${root}/`),
  ];
}

/** Refuses a commit that adds or changes a secret file, even one the repository already has; removing one is fine. */
export function gitPreCommitHook(): string {
  return [
    '#!/bin/sh',
    `found="$(git diff --cached --name-only --diff-filter=ACMR | grep -E ${shellQuote(SECRET_FILE_PATTERN)} | grep -vE ${shellQuote(SECRET_EXAMPLE_PATTERN)} || true)"`,
    '[ -z "$found" ] && exit 0',
    `printf 'Not saved, a secret file: %s\\n%s Take it out of this commit with git restore --staged <file>.\\n' "$found" ${shellQuote(SECRETS_ADVICE)} >&2`,
    'exit 1',
    '',
  ].join('\n');
}

/** The hooks after which the branches are saved: whatever moves a branch or the branch checked out. */
export const GIT_SAVE_HOOKS = ['post-commit', 'post-rewrite', 'post-merge', 'post-checkout'] as const;

/**
 * Saves every branch to the workspace's own refs in the project's repository (a branch deleted here goes
 * there too), then tells the git proxy the branch and commit checked out, so git in the next container
 * has its commits back, pushed or not. It runs in the background, one save at a time, and never fails or
 * slows what ran it; a save that fails is made whole by the next one. The pre-push hook checks it as any push.
 */
export function gitSaveHook(): string {
  const real = shellQuote(REAL_GIT);
  return [
    '#!/bin/sh',
    `saved="$(${real} config --get cloudchef.saved || true)"`,
    '[ -n "$saved" ] || exit 0',
    '(',
    '  flock 8',
    `  ${real} push -q --force --prune origin "refs/heads/*:$saved/*" || exit 0`,
    `  branch="$(${real} symbolic-ref -q --short HEAD)" && commit="$(${real} rev-parse -q --verify HEAD)" || exit 0`,
    `  curl -fsS -o /dev/null -X POST --data-binary "$branch $commit" ${shellQuote(`http://${GIT_PROXY_HOST}${GIT_BASE_PATH}`)} || true`,
    `) 8>${shellQuote(`${GIT_ROOT}/.save-lock`)} </dev/null >/dev/null 2>&1 &`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Refuses rewriting `main`, which would erase versions others rely on (a refused push is rebased with
 * `git pull`, then pushed again), and pushing a secret file a commit somehow holds.
 */
export function gitPrePushHook(): string {
  return [
    '#!/bin/sh',
    `zero=${ZERO_OID}`,
    'refused=0',
    'while read -r local_ref local_oid remote_ref remote_oid; do',
    '  [ "$local_oid" = "$zero" ] && continue',
    '  if [ "$remote_ref" = refs/heads/main ] && [ "$remote_oid" != "$zero" ] && ! git merge-base --is-ancestor "$remote_oid" "$local_oid" 2>/dev/null; then',
    `    echo ${shellQuote("main can't be rewritten. Run git pull, then push again.")} >&2`,
    '    refused=1',
    '    continue',
    '  fi',
    '  if [ "$remote_oid" = "$zero" ]; then',
    '    files="$(git log --format= --name-only --diff-filter=ACMR "$local_oid" --not --remotes=origin)"',
    '  else',
    '    files="$(git log --format= --name-only --diff-filter=ACMR "$remote_oid..$local_oid")"',
    '  fi',
    `  found="$(printf '%s\\n' "$files" | grep -E ${shellQuote(SECRET_FILE_PATTERN)} | grep -vE ${shellQuote(SECRET_EXAMPLE_PATTERN)} | sort -u || true)"`,
    '  if [ -n "$found" ]; then',
    `    printf 'Not pushed, a commit holds a secret file: %s\\n%s\\n' "$found" ${shellQuote(SECRETS_ADVICE)} >&2`,
    '    refused=1',
    '  fi',
    'done',
    'exit "$refused"',
    '',
  ].join('\n');
}

/**
 * The `cf` launcher: the project's own pinned CLI when installed, else the same pin installed once
 * through the shared pnpm store, so the project's later install reuses the download.
 */
export function cfCliLauncherScript(accountId: string): string {
  const projectCf = `${WORK_DIR}/node_modules/.bin/cf`;
  const installRoot = `${CF_CLI_ROOT}/${CF_CLI_VERSION}`;
  return [
    '#!/bin/sh',
    'set -eu',
    `export CLOUDFLARE_ACCOUNT_ID=${shellQuote(accountId)}`,
    // The proxy puts the account's authorization in place of this stand-in; the container never holds it.
    `export CLOUDFLARE_API_BASE_URL=${shellQuote(CLOUDFLARE_API_PROXY_BASE_URL)}`,
    `export CLOUDFLARE_API_TOKEN=${shellQuote(CLOUDFLARE_API_PROXY_TOKEN)}`,
    `if [ -x ${shellQuote(projectCf)} ]; then exec ${shellQuote(projectCf)} "$@"; fi`,
    `root=${shellQuote(installRoot)}`,
    'if [ ! -x "$root/node_modules/.bin/cf" ]; then',
    `  mkdir -p ${shellQuote(CF_CLI_ROOT)}`,
    `  staging="$(mktemp -d ${shellQuote(`${CF_CLI_ROOT}/.install.XXXXXX`)})"`,
    `  pnpm add --dir "$staging" cf@${CF_CLI_VERSION} --store-dir ${shellQuote(CONTAINER_PNPM_STORE_DIR)} --prefer-offline --ignore-scripts --no-optional --reporter=silent --registry=https://registry.npmjs.org/ >&2`,
    '  mv -T "$staging" "$root" 2>/dev/null || rm -rf "$staging"',
    'fi',
    'exec "$root/node_modules/.bin/cf" "$@"',
    '',
  ].join('\n');
}

/**
 * `cloudchef validate` is answered by the agent's exec tool itself, which runs the project's full validation (the
 * one a publish recognizes) when the command is exactly that. Reaching this script means it was run some other
 * way: inside a longer command line, or from the terminal.
 */
export function cloudchefCommandScript(): string {
  return [
    '#!/bin/sh',
    `echo ${shellQuote(`${VALIDATE_COMMAND} runs the project's full checks when the agent runs it as a command of its own, exactly as written.`)} >&2`,
    'exit 2',
    '',
  ].join('\n');
}

export function strictSubshellCommand(lines: readonly string[]): string {
  return ['(', 'set -eu', ...lines, ')'].join('\n');
}
