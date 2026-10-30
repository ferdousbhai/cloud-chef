import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_DIR } from '../../cloudchef-agent/constants';
import { CONTAINER_PNPM_STORE_DIR } from './container-toolchain';
import {
  parseTerminalResize,
  TERMINAL_HOME,
  terminalCommand,
  terminalEnvironment,
  terminalSessionCommand,
  TERMINAL_PROMPT_FILE,
} from './workspace-terminal';

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

  it('attaches to the one kept tmux session, or starts it in the folder with the environment and login shell', () => {
    const argv = terminalSessionCommand(WORK_DIR, 'alberta-plan-glossary');

    expect(argv.slice(0, 7)).toEqual(['tmux', 'new-session', '-A', '-s', 'workspace', '-c', WORK_DIR]);
    expect(argv).toContain(`HOME=${TERMINAL_HOME}`);
    expect(argv).toContain('TERM=xterm-256color');
    expect(argv).toContain('CLOUDCHEF_PROJECT=alberta-plan-glossary');
    expect(argv.slice(-3)).toEqual([...terminalCommand()]);
  });

  it('takes a resize from both the current page and a page from before Sandbox 1.0, and nothing else', () => {
    expect(parseTerminalResize('{"cols":120,"rows":40}')).toEqual({ cols: 120, rows: 40 });
    expect(parseTerminalResize('{"type":"resize","cols":120,"rows":40}')).toEqual({ cols: 120, rows: 40 });
    expect(parseTerminalResize('{"cols":1,"rows":40}')).toBeNull();
    expect(parseTerminalResize('{"cols":"120","rows":40}')).toBeNull();
    expect(parseTerminalResize('not json')).toBeNull();
    expect(parseTerminalResize('null')).toBeNull();
  });

  it('creates the home quietly, then starts a login shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-home-'));
    const home = join(root, 'user');
    const work = join(root, 'work');
    mkdirSync(join(work, 'src', 'routes'), { recursive: true });
    const [shell, flag, script] = terminalCommand();
    expect(script).toMatch(/\nexec \/bin\/bash -l$/);
    const testScript = script
      .replace('exec /bin/bash -l', 'echo started')
      .replaceAll(TERMINAL_HOME, home)
      .replace(TERMINAL_PROMPT_FILE, join(root, 'prompt.sh'))
      .replaceAll(WORK_DIR, work);
    const run = () => spawnSync(shell, [flag, testScript], { encoding: 'utf8' });

    // What the workspace keeps is said in the terminal panel, never typed into the shell.
    const first = run();
    expect(first.status).toBe(0);
    expect(existsSync(home)).toBe(true);
    expect(first.stdout).toBe('started\n');

    const again = run();
    expect(again.status).toBe(0);
    expect(again.stdout).toBe('started\n');

    // The prompt names the project and where in it the shell is, never the container.
    const prompt = (cwd: string, project?: string) =>
      spawnSync('/bin/bash', ['-c', 'source "$1"; printf %s "${PS1@P}"', '_', join(root, 'prompt.sh')], {
        cwd,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, CLOUDCHEF_PROJECT: project },
      }).stdout;
    expect(prompt(work, 'alberta-plan-glossary')).toBe('alberta-plan-glossary$ ');
    expect(prompt(join(work, 'src', 'routes'), 'alberta-plan-glossary')).toBe('alberta-plan-glossary/src/routes$ ');
    expect(prompt(home, 'alberta-plan-glossary')).toBe('alberta-plan-glossary:~$ ');
    expect(prompt(work)).toBe('project$ ');
  });
});
