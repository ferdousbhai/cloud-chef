import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitPreCommitHook, gitPrePushHook, gitSetupScript, gitWrapperScript } from './container-toolchain';

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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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

/** A stand-in for the proxy's workspace answer, as the setup script asks curl for it. */
function answerWith(base: string | null): void {
  write(
    join(root, 'bin', 'curl'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${join(root, 'curl.log')}'`,
      'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
      `printf 'main ${base ?? '-'}\\nAda Lovelace\\nada@example.com\\n' > "$out"`,
      'printf 200',
      '',
    ].join('\n'),
    true,
  );
}

// The container has both; a machine without them can't run these scripts at all.
const hasTools = existsSync('/usr/bin/git') && ['/usr/bin/flock', '/bin/flock'].some((path) => existsSync(path));

describe.skipIf(!hasTools)("the workspace container's git", () => {
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

  it('starts from main when the workspace names no commit, and from nothing for an empty repository', () => {
    const { head } = remoteAheadOfWorkspace();
    answerWith(null);
    write(join(root, 'git', 'setup'), at(gitSetupScript()), true);
    expect(run(join(root, 'bin', 'git'), ['rev-parse', 'HEAD'], join(root, 'project')).stdout).toBe(head);

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
});
