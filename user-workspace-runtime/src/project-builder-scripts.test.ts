import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asBuildUserCommand, endBuildPhase, fetchCommand } from './project-builder-scripts';

/**
 * The build container's scripts run for real, with the system's shell and git, against a local repository standing
 * in for the source proxy: only the proxy's address is moved.
 */
let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudchef-builder-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the build container's scripts", () => {
  it('fetch exactly the commit, and refuse a branch that moved on', () => {
    const source = join(root, 'source');
    execFileSync('mkdir', ['-p', source]);
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
    writeFileSync(join(source, 'index.html'), 'hello');
    git(source, 'add', '.');
    git(source, '-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-q', '-m', 'First');
    const commit = git(source, 'rev-parse', 'HEAD');
    const fetchInto = (work: string, wanted: string) => {
      execFileSync('mkdir', ['-p', work]);
      const script = fetchCommand({ commit: wanted, branch: 'main' }).replaceAll(
        'http://git.internal/project.git',
        source,
      );
      return spawnSync('sh', ['-c', script], { cwd: work, env, encoding: 'utf8' });
    };

    const fetched = fetchInto(join(root, 'work'), commit);
    expect(fetched.stderr).toBe('');
    expect(fetched.status).toBe(0);
    expect(readFileSync(join(root, 'work', 'index.html'), 'utf8')).toBe('hello');

    const moved = fetchInto(join(root, 'stale'), 'f'.repeat(40));
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain('The branch moved on since this commit.');
  });

  it('are all valid shell, as the shell that runs each reads it', () => {
    for (const [shell, script] of [
      ['sh', fetchCommand({ commit: 'a'.repeat(40), branch: "it's" })],
      ['sh', asBuildUserCommand('npm ci && echo "done"')],
      ['bash', endBuildPhase()],
    ] as const) {
      const checked = spawnSync(shell, ['-n', '-c', script], { encoding: 'utf8' });
      expect(checked.stderr).toBe('');
      expect(checked.status).toBe(0);
    }
  });
});
