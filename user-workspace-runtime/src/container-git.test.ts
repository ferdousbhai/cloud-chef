import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Volume } from 'memfs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitBuilderTemplate, loadBuilderTemplate } from '../../app/agents/builder-template';
import { GIT_SETUP_HEADER } from '../../app/lib/.server/cloudflare/git-proxy';
import { ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
import { fakeArtifacts } from '../../app/test/fake-artifacts';
import {
  GIT_SAVE_HOOKS,
  gitPreCommitHook,
  gitPrePushHook,
  gitSaveHook,
  gitSetupScript,
  gitWrapperScript,
} from './container-toolchain';

/**
 * The container's git scripts run for real, with the system's git, against a local bare repository standing
 * in for the proxy's remote: only the container's fixed paths and the proxy's address are moved.
 */
let root: string;
let env: NodeJS.ProcessEnv;

function at(script: string): string {
  return script
    .replaceAll('/opt/cloudchef/git', join(root, 'git'))
    .replaceAll('/home/project', join(root, 'project'))
    .replaceAll("'/usr/local/bin/git'", `'${join(root, 'bin', 'git')}'`);
}

function write(path: string, content: string, executable = false): void {
  writeFileSync(path, content);
  if (executable) {
    chmodSync(path, 0o755);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8' }).trim();
}

/** Runs a command, returning its exit status, its output, and what it wrote to stderr. */
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudchef-git-'));
  for (const directory of ['bin', 'git', 'project', 'seed']) {
    mkdirSync(join(root, directory));
  }
  write(
    join(root, 'gitconfig'),
    `[url "file://${join(root, 'remote.git')}"]\n\tinsteadOf = http://git.internal/project.git\n[init]\n\tdefaultBranch = main\n`,
  );
  env = {
    PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Seed',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_COMMITTER_NAME: 'Seed',
    GIT_COMMITTER_EMAIL: 'seed@example.com',
  };
  write(join(root, 'bin', 'git'), at(gitWrapperScript()), true);
  mkdirSync(join(root, 'git', 'hooks'));
  write(join(root, 'git', 'hooks', 'pre-commit'), at(gitPreCommitHook()), true);
  write(join(root, 'git', 'hooks', 'pre-push'), at(gitPrePushHook()), true);
  for (const hook of GIT_SAVE_HOOKS) {
    write(join(root, 'git', 'hooks', hook), at(gitSaveHook()), true);
  }
});

afterEach(() => {
  // A save still running in the background gives up once its folders are gone.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Copies the in-memory bare repository at `from` in `volume` to `to` on disk, byte for byte. */
function copyVolume(volume: InstanceType<typeof Volume>, from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of volume.readdirSync(from)) {
    const name = String(entry);
    if (volume.statSync(`${from}/${name}`).isDirectory()) {
      copyVolume(volume, `${from}/${name}`, join(to, name));
    } else {
      writeFileSync(join(to, name), volume.readFileSync(`${from}/${name}`));
    }
  }
}

/** A remote whose main has moved past `base`, the commit the workspace's files match. */
function remoteAheadOfWorkspace() {
  const seed = join(root, 'seed');
  git(seed, 'init', '-q', '-b', 'main');
  write(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'one');
  const base = git(seed, 'rev-parse', 'HEAD');
  write(join(seed, 'a.txt'), 'two\n');
  git(seed, 'commit', '-q', '-am', 'two');
  const head = git(seed, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', '--bare', seed, join(root, 'remote.git'));
  write(join(root, 'project', 'a.txt'), 'one\n');
  write(join(root, 'project', 'b.txt'), 'new\n');
  return { base, head };
}

const SAVED = 'refs/cloudchef/workspaces/w1';

/**
 * A stand-in for the proxy, as the scripts ask curl for it: the workspace answer, based on `base` until a
 * branch and commit are reported, which it then keeps as the proxy does.
 */
function answerWith(base: string | null, branch = 'main'): void {
  write(join(root, 'base'), `${branch} ${base ?? '-'}\n`);
  write(
    join(root, 'bin', 'curl'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${join(root, 'curl.log')}'`,
      'data=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; --data-binary) data="$2"; shift;; esac; shift; done',
      `if [ -n "$data" ]; then printf '%s\\n' "$data" > '${join(root, 'base')}'; exit 0; fi`,
      `{ cat '${join(root, 'base')}'; printf 'Ada Lovelace\\nada@example.com\\n${SAVED}\\n'; } > "$out"`,
      'printf 200',
      '',
    ].join('\n'),
    true,
  );
}

/** Waits for the save hook, which runs in the background, to leave `done` true. */
async function eventually(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error('The branches were not saved in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What the stand-in remote's `ref` is, or null. */
function remoteRef(ref: string): string | null {
  const result = spawnSync(
    '/usr/bin/git',
    ['--git-dir', join(root, 'remote.git'), 'rev-parse', '-q', '--verify', ref],
    {
      env,
      encoding: 'utf8',
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

// The container has both; a machine without them can't run these scripts at all.
const hasTools = existsSync('/usr/bin/git') && ['/usr/bin/flock', '/bin/flock'].some((path) => existsSync(path));

describe.skipIf(!hasTools)("the workspace container's git", { timeout: 30_000 }, () => {
  it('sets up the history on first use, based on the commit the files match', () => {
    const { base, head } = remoteAheadOfWorkspace();
    answerWith(base);
    const project = join(root, 'project');
    // The real setup is at <root>/git/setup; the wrapper calls it there.
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const status = run(join(root, 'bin', 'git'), ['status', '--porcelain'], project);
    expect(status.status).toBe(0);
    // Main moved on to "two", but the files match "one": only the new file is a change, nothing is undone.
    expect(status.stdout).toBe('?? b.txt');
    expect(run(join(root, 'bin', 'git'), ['rev-parse', 'HEAD'], project).stdout).toBe(base);
    expect(run(join(root, 'bin', 'git'), ['rev-parse', 'origin/main'], project).stdout).toBe(head);
    expect(run(join(root, 'bin', 'git'), ['config', 'user.name'], project).stdout).toBe('Ada Lovelace');
    expect(run(join(root, 'bin', 'git'), ['rev-parse', '--git-dir'], join(project)).stdout).toBe(
      join(root, 'git', 'project.git'),
    );
    // Its fetch says it is the setup's, so the proxy doesn't count origin/main as taken by the files.
    expect(gitSetupScript()).toContain(`http.extraHeader='${GIT_SETUP_HEADER}: 1' fetch`);
  });

  it("starts a new project's history from its whole template, so a commit of one changed file pushes only that change", async () => {
    // The new project's repository as CloudChef makes it, copied to disk as the stand-in remote, and the
    // workspace seeded from it as the agent seeds one.
    const artifacts = fakeArtifacts();
    const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
    await commitBuilderTemplate(repositories, 'p-new', { name: 'Ada Lovelace', email: 'ada@example.com' });
    const created = artifacts.repos.get('p-new');
    if (!created) {
      throw new Error('The new project has no repository.');
    }
    copyVolume(created.volume, created.gitdir, join(root, 'remote.git'));
    const { commit: start, files } = await repositories.readFilesAt('p-new', 'main');
    const project = join(root, 'project');
    for (const file of files) {
      mkdirSync(dirname(join(project, file.path)), { recursive: true });
      writeFileSync(join(project, file.path), file.bytes);
    }
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const wrapped = join(root, 'bin', 'git');
    expect(run(wrapped, ['status', '--porcelain'], project).stdout).toBe('');

    write(join(project, 'index.html'), '<h1>Canary OK</h1>\n');
    run(wrapped, ['add', 'index.html'], project);
    expect(run(wrapped, ['commit', '-q', '-m', 'Canary page'], project).status).toBe(0);
    expect(run(wrapped, ['push', '-q', 'origin', 'main'], project).status).toBe(0);

    const remote = (...args: string[]) => git(root, '--git-dir', join(root, 'remote.git'), ...args);
    const template = (await loadBuilderTemplate()).map((entry) => entry.path.slice('/home/project/'.length));
    expect(remote('ls-tree', '-r', '--name-only', 'main').split('\n').sort()).toEqual(template.sort());
    expect(remote('rev-parse', 'main~1')).toBe(start.hash);
    expect(remote('diff', '--name-only', 'main~1', 'main')).toBe('index.html');
    expect(remote('show', 'main:index.html')).toBe('<h1>Canary OK</h1>');
  });

  it("leaves a symbolic link the workspace can't hold as it is, rather than showing it removed", () => {
    const seed = join(root, 'seed');
    git(seed, 'init', '-q', '-b', 'main');
    write(join(seed, 'AGENTS.md'), 'notes\n');
    execFileSync('ln', ['-s', 'AGENTS.md', join(seed, 'CLAUDE.md')]);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'notes');
    git(root, 'clone', '-q', '--bare', seed, join(root, 'remote.git'));
    write(join(root, 'project', 'AGENTS.md'), 'notes\n');
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    expect(run(wrapped, ['status', '--porcelain'], project).stdout).toBe('');
    write(join(project, 'b.txt'), 'new\n');
    run(wrapped, ['add', '-A'], project);
    expect(run(wrapped, ['commit', '-q', '-am', 'b'], project).status).toBe(0);
    expect(run(wrapped, ['ls-tree', '--name-only', 'HEAD'], project).stdout.split('\n')).toContain('CLAUDE.md');
  });

  it('starts from main when the workspace names no commit, or one the repository lacks, and from nothing for an empty repository', () => {
    const { head } = remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    expect(run(join(root, 'bin', 'git'), ['rev-parse', 'HEAD'], join(root, 'project')).stdout).toBe(head);

    rmSync(join(root, 'git', 'project.git'), { recursive: true });
    answerWith('c'.repeat(40), 'gone');
    expect(run(join(root, 'bin', 'git'), ['rev-parse', 'HEAD'], join(root, 'project')).stdout).toBe(head);
    expect(run(join(root, 'bin', 'git'), ['symbolic-ref', '--short', 'HEAD'], join(root, 'project')).stdout).toBe(
      'main',
    );

    rmSync(join(root, 'git', 'project.git'), { recursive: true });
    rmSync(join(root, 'remote.git'), { recursive: true });
    git(root, 'init', '-q', '--bare', join(root, 'remote.git'));
    const empty = run(join(root, 'bin', 'git'), ['status', '--porcelain'], join(root, 'project'));
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain('?? a.txt');
  });

  it('refuses to save or push secret files, but not their documented examples', () => {
    remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    write(join(project, '.env.example'), 'KEY=\n');
    expect(run(wrapped, ['add', '.env.example', 'b.txt'], project).status).toBe(0);
    expect(run(wrapped, ['commit', '-q', '-m', 'example'], project).status).toBe(0);

    write(join(project, '.dev.vars'), 'KEY=secret\n');
    // Excluded by default, so an ordinary add leaves it out...
    run(wrapped, ['add', '-A'], project);
    expect(run(wrapped, ['diff', '--cached', '--name-only'], project).stdout).not.toContain('.dev.vars');
    // ...and forced in, the commit is refused.
    run(wrapped, ['add', '-f', '.dev.vars'], project);
    const refused = run(wrapped, ['commit', '-q', '-m', 'secret'], project);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('Secrets belong in Cloudflare');

    // Taking a secret out of the commit, as the advice says, works.
    expect(run(wrapped, ['restore', '--staged', '.dev.vars'], project).status).toBe(0);
    run(wrapped, ['add', '-f', '.dev.vars'], project);
    const sneaked = run(wrapped, ['commit', '-q', '--no-verify', '-m', 'secret'], project);
    expect(sneaked.status).toBe(0);
    const push = run(wrapped, ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], project);
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain('a commit holds a secret file: .dev.vars');
  });

  it("refuses rewriting main, and pushes main's new commits", () => {
    remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    run(wrapped, ['add', 'b.txt'], project);
    expect(run(wrapped, ['commit', '-q', '-m', 'b'], project).status).toBe(0);
    expect(run(wrapped, ['push', '-q', 'origin', 'main'], project).status).toBe(0);
    // Where git in the next container starts: the branch checked out, at the commit just pushed.
    const head = run(wrapped, ['rev-parse', 'HEAD'], project).stdout;
    expect(readFileSync(join(root, 'curl.log'), 'utf8')).toContain(
      `--data-binary main ${head} http://git.internal/_cloudchef/base`,
    );

    run(wrapped, ['reset', '-q', '--soft', 'HEAD~2'], project);
    expect(run(wrapped, ['commit', '-q', '-m', 'squashed'], project).status).toBe(0);
    const rewrite = run(wrapped, ['push', '-q', '--force', 'origin', 'main'], project);
    expect(rewrite.status).not.toBe(0);
    expect(rewrite.stderr).toContain("main can't be rewritten");
  });

  it('lets a commit remove a secret file the repository already tracks', () => {
    const seed = join(root, 'seed');
    git(seed, 'init', '-q', '-b', 'main');
    write(join(seed, '.env'), 'SECRET=1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'oops');
    git(root, 'clone', '-q', '--bare', seed, join(root, 'remote.git'));
    write(join(root, 'project', '.env'), 'SECRET=1\n');
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    expect(run(wrapped, ['rm', '-q', '--cached', '.env'], project).status).toBe(0);
    expect(run(wrapped, ['commit', '-q', '-m', 'Remove the secret'], project).status).toBe(0);
    expect(run(wrapped, ['push', '-q', 'origin', 'main'], project).status).toBe(0);
  });

  it('keeps commits not yet pushed, with their messages and branches, when the container restarts', async () => {
    const { base, head: originMain } = remoteAheadOfWorkspace();
    answerWith(base);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    run(wrapped, ['add', 'b.txt'], project);
    expect(run(wrapped, ['commit', '-q', '-m', 'Add b'], project).status).toBe(0);
    const onMain = run(wrapped, ['rev-parse', 'HEAD'], project).stdout;
    run(wrapped, ['branch', 'stale'], project);
    expect(run(wrapped, ['switch', '-q', '-c', 'feature'], project).status).toBe(0);
    write(join(project, 'c.txt'), 'c\n');
    run(wrapped, ['add', 'c.txt'], project);
    expect(run(wrapped, ['commit', '-q', '-m', 'Add c'], project).status).toBe(0);
    await eventually(() => remoteRef(`${SAVED}/stale`) === onMain);
    // A branch deleted here goes from the saved ones at the next save.
    run(wrapped, ['branch', '-q', '-D', 'stale'], project);
    expect(run(wrapped, ['commit', '-q', '--amend', '-m', 'Add c, amended'], project).status).toBe(0);
    const onFeature = run(wrapped, ['rev-parse', 'HEAD'], project).stdout;
    await eventually(
      () =>
        remoteRef(`${SAVED}/feature`) === onFeature &&
        remoteRef(`${SAVED}/stale`) === null &&
        readFileSync(join(root, 'base'), 'utf8') === `feature ${onFeature}\n`,
    );
    // Nothing was pushed: main and the project's own branches are as they were.
    expect(remoteRef('refs/heads/main')).toBe(originMain);
    expect(remoteRef('refs/heads/feature')).toBeNull();

    // The container restarts: its disk, and the history on it, are gone; the files are kept.
    rmSync(join(root, 'git', 'project.git'), { recursive: true });
    const status = run(wrapped, ['status', '--porcelain'], project);
    expect(status.status).toBe(0);
    expect(status.stdout).toBe('');
    expect(run(wrapped, ['symbolic-ref', '--short', 'HEAD'], project).stdout).toBe('feature');
    expect(run(wrapped, ['rev-parse', 'HEAD'], project).stdout).toBe(onFeature);
    expect(run(wrapped, ['log', '-1', '--format=%s'], project).stdout).toBe('Add c, amended');
    expect(run(wrapped, ['log', '-1', '--format=%s', 'main'], project).stdout).toBe('Add b');
    expect(run(wrapped, ['branch', '--format=%(refname:short)'], project).stdout.split('\n')).toEqual([
      'feature',
      'main',
    ]);
    expect(run(wrapped, ['rev-parse', '--abbrev-ref', 'main@{upstream}'], project).stdout).toBe('origin/main');
    expect(run(wrapped, ['for-each-ref', 'refs/cloudchef'], project).stdout).toBe('');
  });

  it("builds on a teammate's push of main: a push behind it is turned away with git's advice to pull, and the pull puts this work on top", () => {
    remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    run(wrapped, ['status'], project);
    // A teammate's workspace started from the same main, and pushed first.
    const teammate = join(root, 'teammate');
    git(root, 'clone', '-q', join(root, 'remote.git'), teammate);
    write(join(teammate, 'c.txt'), 'theirs\n');
    git(teammate, 'add', 'c.txt');
    git(teammate, 'commit', '-q', '-m', 'Add c');
    git(teammate, 'push', '-q', 'origin', 'main');

    run(wrapped, ['add', 'b.txt'], project);
    expect(run(wrapped, ['commit', '-q', '-m', 'Add b'], project).status).toBe(0);
    const behind = run(wrapped, ['push', '-q', 'origin', 'main'], project);
    expect(behind.status).not.toBe(0);
    expect(behind.stderr).toContain('git pull');
    expect(remoteRef('refs/heads/main')).toBe(git(teammate, 'rev-parse', 'HEAD'));

    // An edit saved but not committed (the person's editor, say) is set aside for the pull and put back.
    write(join(project, 'a.txt'), 'edited\n');
    const pulled = run(wrapped, ['pull', '-q'], project);
    expect(pulled.status).toBe(0);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('edited\n');
    expect(readFileSync(join(project, 'c.txt'), 'utf8')).toBe('theirs\n');
    expect(run(wrapped, ['log', '--format=%s', '-3'], project).stdout.split('\n')).toEqual(['Add b', 'Add c', 'two']);
    expect(run(wrapped, ['push', '-q', 'origin', 'main'], project).status).toBe(0);
    expect(remoteRef('refs/heads/main')).toBe(run(wrapped, ['rev-parse', 'HEAD'], project).stdout);
  });

  it('stops a pull where a teammate changed the same lines differently, and puts everything back on abort', () => {
    remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    run(wrapped, ['status'], project);
    const teammate = join(root, 'teammate');
    git(root, 'clone', '-q', join(root, 'remote.git'), teammate);
    write(join(teammate, 'a.txt'), 'theirs\n');
    git(teammate, 'commit', '-q', '-am', 'Theirs');
    git(teammate, 'push', '-q', 'origin', 'main');

    write(join(project, 'a.txt'), 'mine\n');
    expect(run(wrapped, ['commit', '-q', '-am', 'Mine'], project).status).toBe(0);
    const mine = run(wrapped, ['rev-parse', 'HEAD'], project).stdout;
    const pulled = run(wrapped, ['pull'], project);
    expect(pulled.status).not.toBe(0);
    expect(`${pulled.stdout}\n${pulled.stderr}`).toContain('CONFLICT');

    expect(run(wrapped, ['rebase', '--abort'], project).status).toBe(0);
    expect(run(wrapped, ['rev-parse', 'HEAD'], project).stdout).toBe(mine);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('mine\n');
  });

  it('never fails or holds up a commit when its branches cannot be saved', () => {
    remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    const project = join(root, 'project');
    const wrapped = join(root, 'bin', 'git');
    run(wrapped, ['status'], project);
    rmSync(join(root, 'remote.git'), { recursive: true });
    write(join(root, 'bin', 'curl'), '#!/bin/sh\nexit 7\n', true);
    run(wrapped, ['add', 'b.txt'], project);
    const started = Date.now();
    const commit = run(wrapped, ['commit', '-q', '-m', 'Add b'], project);
    expect(commit.status).toBe(0);
    expect(commit.stderr).toBe('');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run(wrapped, ['log', '-1', '--format=%s'], project).stdout).toBe('Add b');
  });
});
