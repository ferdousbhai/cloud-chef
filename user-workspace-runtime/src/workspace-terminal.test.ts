import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_DIR } from '../../cloudchef-agent/constants';
import { CONTAINER_PNPM_STORE_DIR } from './container-toolchain';
import { TERMINAL_HOME, terminalCommand, terminalEnvironment } from './workspace-terminal';

describe('workspace terminal', () => {
  it('keeps its home under /home, outside the project, and its caches and installs on the container disk', () => {
    const env = terminalEnvironment();

    expect(env.HOME).toBe(TERMINAL_HOME);
    expect(TERMINAL_HOME.startsWith('/home/')).toBe(true);
    expect(`${TERMINAL_HOME}/`.startsWith(`${WORK_DIR}/`)).toBe(false);
    expect(`${WORK_DIR}/`.startsWith(`${TERMINAL_HOME}/`)).toBe(false);
    for (const key of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'npm_config_cache', 'PNPM_HOME'] as const) {
      expect(env[key].startsWith('/root/'), key).toBe(true);
    }
    expect(env.npm_config_store_dir).toBe(CONTAINER_PNPM_STORE_DIR);
    expect(env.CF_SEND_TELEMETRY).toBe('false');
    expect(env.TERM).toBe('xterm-256color');
  });

  it('creates the home and says it is kept only the first time, then starts a login shell', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'terminal-home-')), 'user');
    const [shell, flag, script] = terminalCommand();
    expect(script).toMatch(/\nexec \/bin\/bash -l$/);
    const testScript = script.replace('exec /bin/bash -l', 'echo started').replaceAll(TERMINAL_HOME, home);
    const run = () => spawnSync(shell, [flag, testScript], { encoding: 'utf8' });

    const first = run();
    expect(first.status).toBe(0);
    expect(existsSync(home)).toBe(true);
    expect(first.stdout).toBe(
      `Your home folder, ${home}, is kept with this workspace: sign-ins and settings saved there stay after a restart. Installed tools and caches don't.\n\nstarted\n`,
    );

    const again = run();
    expect(again.status).toBe(0);
    expect(again.stdout).toBe('started\n');
  });
});
