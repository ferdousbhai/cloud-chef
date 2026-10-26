import { GENERATED_PROJECT_PNPM_VERSION } from '../../cloudchef-agent/cloudflare-computer';
import { WORK_DIR } from '../../cloudchef-agent/constants';
import templatePackage from '../../template/package.json' with { type: 'json' };
import { CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS } from './operation-lease-policy';
import { shellQuote } from './shell-quote';
import { abortableSleep } from '../../app/lib/abortable-sleep';
import { GIT_PROXY_HOST } from '../../app/lib/.server/cloudflare/git-proxy';
import { ZERO_OID } from '../../app/lib/.server/cloudflare/repository-wire';

/**
 * Where the bootstrap installs computerd on the stock Sandbox image. `/opt` rather than `/tmp` so
 * it cannot be shadowed by a tmpfs mount. Container disk is wiped on every sleep, so the bootstrap
 * re-fetches the layer on each cold container.
 */
export const COMPUTERD_ROOT = '/opt/cloudchef/computer';
// Immutable linux/amd64 layer published by
// ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1. Keep in lockstep with the
// @cloudflare/computer client version in package.json so the capnweb protocols match.
const COMPUTERD_LAYER_DIGEST = 'sha256:3234a308871d16fb07a28c16ee56454785ef4360ea0a507a2392cb77d881044a';

export const COMPUTERD_BINARY = `${COMPUTERD_ROOT}/usr/local/bin/computerd`;
export const COMPUTERD_INSTALLATION_CURRENT = 'current';
const COMPUTERD_INSTALLATION_STALE = 'stale';

/**
 * One content-addressed pnpm store for every install this container runs. Passed explicitly on the
 * install command rather than left to config discovery, so every install lands on the same store
 * and a second install in the same container reuses the first one's downloads.
 */
export const CONTAINER_PNPM_STORE_DIR = '/opt/cloudchef/pnpm-store';

/**
 * The toolchain bootstrap is a network package installation into the same
 * container the project's own installs run in, so it shares their ceiling
 * rather than declaring another number (#131). The production defect was the
 * opposite shape: the bootstrap was effectively bounded at 30 seconds by
 * @cloudflare/sandbox's hardcoded `DEFAULT_CONNECT_TIMEOUT_MS` — its exec
 * launch aborts when the capnweb upgrade to a cold container takes longer —
 * a ceiling far below every one declared in this repository.
 */
export const CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS = CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS;

/** Downloading and verifying the pinned computerd layer from GHCR. */
export const COMPUTERD_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

/** Health probing, POST /connect, and the /ws upgrade that follow the bootstraps. */
const CONTAINER_CONNECT_STAGES_MARGIN_MS = 2 * 60_000;

/**
 * @cloudflare/computer's CloudflareContainerBackend arms its whole connect
 * deadline before calling `host.start()`, so both bootstraps spend from this
 * same budget. Derive it as the sum of the stages it must cover, so the vendor
 * deadline cannot silently undercut a stage budget declared here (the #127
 * guard shape, pinned by test).
 */
export const CONTAINER_CONNECT_TIMEOUT_MS =
  CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS + COMPUTERD_BOOTSTRAP_TIMEOUT_MS + CONTAINER_CONNECT_STAGES_MARGIN_MS;

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
 * Both bootstrap commands are idempotent by construction — they install only
 * when the pinned version or binary is absent — so retrying after any failure
 * is safe. The failure this exists for is @cloudflare/sandbox aborting an exec
 * launch after its hardcoded 30-second control-connection timeout while the
 * container is still starting; the SDK itself classifies that abort as a
 * transient startup error, and without a retry it became a durable dead end
 * for the workspace (#131).
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

/**
 * Install pnpm and a `cf` launcher, in one bootstrap stage.
 *
 * Only discovery (`cf cli search`, `cf schema`) and `--dry-run` are useful here: the container
 * holds no Cloudflare credential, and the runtime Worker sends the request the model copies from
 * dry-run output. The account id makes those dry-run URLs name the connected account. The launcher
 * runs the project's own pinned `cf` once dependencies are installed, and otherwise fetches the same
 * pin on first use, without the optional local simulator nothing here runs. Concurrent first uses
 * each stage their own install and the first rename wins.
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
    `test -x ${shellQuote(REAL_GIT)}`,
    `mkdir -p ${shellQuote(GIT_HOOKS)}`,
    ...[
      [GIT_WRAPPER, gitWrapperScript()],
      [GIT_SETUP, gitSetupScript()],
      [`${GIT_HOOKS}/pre-commit`, gitPreCommitHook()],
      [`${GIT_HOOKS}/pre-push`, gitPrePushHook()],
    ].flatMap(([path, script]) => [
      `printf %s ${shellQuote(script)} > ${shellQuote(path)}`,
      `chmod 0755 ${shellQuote(path)}`,
    ]),
  ]);
}

/**
 * git for the project. Its history lives on the container's own disk, outside `/home`, which the
 * workspace stores durably whole: the project's files are kept, and a new container sets up the history
 * again from the project's repository on first use. The remote is the runtime's git proxy, so nothing
 * here holds a credential.
 */
export const GIT_WRAPPER = '/usr/local/bin/git';
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
 */
export function gitWrapperScript(): string {
  return [
    '#!/bin/sh',
    'case "$PWD/" in',
    `  ${WORK_DIR}/*)`,
    '    if [ -z "${GIT_DIR:-}" ] && [ ! -e "$PWD/.git" ]; then',
    `      export GIT_DIR=${shellQuote(GIT_DIR)} GIT_WORK_TREE=${shellQuote(WORK_DIR)}`,
    `      [ -f "$GIT_DIR/HEAD" ] || ${shellQuote(GIT_SETUP)} || exit 1`,
    '    fi',
    '    ;;',
    'esac',
    `exec ${shellQuote(REAL_GIT)} "$@"`,
    '',
  ].join('\n');
}

/**
 * Sets up the project's history once per container, under a lock: fetched through the proxy and based on
 * the commit the workspace's files match, so `git status` shows exactly what changed since. Only the index
 * is written; the files are already there.
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
    'staging="$(mktemp -d "$root/.setup.XXXXXX")"',
    `g() { GIT_DIR="$staging" GIT_WORK_TREE=${shellQuote(WORK_DIR)} ${shellQuote(REAL_GIT)} "$@"; }`,
    'g init -q -b main',
    `g remote add origin ${shellQuote(GIT_REMOTE)}`,
    'g config user.name "$name"',
    'g config user.email "$email"',
    `g config core.hooksPath ${shellQuote(GIT_HOOKS)}`,
    'g config pull.rebase true',
    'g config push.autoSetupRemote true',
    'g fetch -q origin',
    'if [ "$commit" != - ] && g cat-file -e "$commit^{commit}" 2>/dev/null; then',
    '  start="$commit"',
    'elif start="$(g rev-parse -q --verify refs/remotes/origin/main)"; then',
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

/** Records which computerd layer the container currently holds, so the bootstrap can re-install on
 * a version change instead of trusting a stale binary. */
const COMPUTERD_LAYER_MARKER = `${COMPUTERD_ROOT}/.layer-digest`;

/**
 * A running process is reusable only when it was launched from the computerd layer paired with
 * this client. Sandbox processes can outlive a Worker code update while their container remains
 * warm, so process liveness alone is not a compatibility check.
 */
export async function reusableComputerdProcess<T extends { status(): Promise<{ state: string }> }>(
  process: T | null,
  readInstallationState: () => Promise<string>,
): Promise<T | null> {
  if (!process || (await process.status()).state !== 'running') {
    return null;
  }
  return (await readInstallationState()) === COMPUTERD_INSTALLATION_CURRENT ? process : null;
}

/** Read through Sandbox's native process API, not computerd, so a stale computerd can be rejected. */
export function computerdInstallationStateCommand(): string {
  return strictSubshellCommand([
    `if [ "$(cat ${shellQuote(COMPUTERD_LAYER_MARKER)} 2>/dev/null)" = ${shellQuote(COMPUTERD_LAYER_DIGEST)} ] && [ -x ${shellQuote(COMPUTERD_BINARY)} ]; then`,
    `  printf %s ${shellQuote(COMPUTERD_INSTALLATION_CURRENT)}`,
    'else',
    `  printf %s ${shellQuote(COMPUTERD_INSTALLATION_STALE)}`,
    'fi',
  ]);
}

export function computerdBootstrapCommand(): string {
  const tokenUrl =
    'https://ghcr.io/token?service=ghcr.io&scope=repository:cloudflare/computer-computerd-linux-x64:pull';
  const blobUrl = `https://ghcr.io/v2/cloudflare/computer-computerd-linux-x64/blobs/${COMPUTERD_LAYER_DIGEST}`;
  const layerPath = `${COMPUTERD_ROOT}/layer.tgz`;
  // Gate on the exact layer digest, not mere existence. A warm container survives a control-plane
  // upgrade, so a computerd from an earlier @cloudflare/computer version would otherwise persist and
  // talk a stale exec protocol to the new client — the container shell then runs a mangled command.
  // Re-install whenever the recorded digest does not match the pinned one.
  return strictSubshellCommand([
    `if [ "$(cat ${shellQuote(COMPUTERD_LAYER_MARKER)} 2>/dev/null)" != ${shellQuote(COMPUTERD_LAYER_DIGEST)} ] || [ ! -x ${shellQuote(COMPUTERD_BINARY)} ]; then`,
    `  rm -rf ${shellQuote(COMPUTERD_ROOT)}`,
    `  mkdir -p ${shellQuote(COMPUTERD_ROOT)}`,
    `  token="$(curl -fsSL ${shellQuote(tokenUrl)} | jq -er .token)"`,
    `  curl -fsSL -H "Authorization: Bearer $token" -o ${shellQuote(layerPath)} ${shellQuote(blobUrl)}`,
    `  echo ${shellQuote(`${COMPUTERD_LAYER_DIGEST.slice('sha256:'.length)}  ${layerPath}`)} | sha256sum -c -`,
    `  tar -xzf ${shellQuote(layerPath)} -C ${shellQuote(COMPUTERD_ROOT)}`,
    `  chmod 0755 ${shellQuote(COMPUTERD_BINARY)}`,
    `  rm -f ${shellQuote(layerPath)}`,
    `  echo ${shellQuote(COMPUTERD_LAYER_DIGEST)} > ${shellQuote(COMPUTERD_LAYER_MARKER)}`,
    'fi',
    `test -x ${shellQuote(COMPUTERD_BINARY)}`,
  ]);
}

export function strictSubshellCommand(lines: readonly string[]): string {
  return ['(', 'set -eu', ...lines, ')'].join('\n');
}
