import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_PROJECT_PNPM_VERSION } from '../../cloudchef-agent/cloudflare-computer';
import {
  BOOTSTRAP_RETRY_DELAY_MS,
  CF_CLI_VERSION,
  CF_CLI_WRAPPER,
  cfCliLauncherScript,
  cloudchefCommandScript,
  COMPUTERD_BINARY,
  COMPUTERD_INSTALLATION_CURRENT,
  COMPUTERD_ROOT,
  COMPUTERD_BOOTSTRAP_TIMEOUT_MS,
  CONTAINER_CONNECT_TIMEOUT_MS,
  CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS,
  ContainerToolchainBootstrapError,
  computerdBootstrapCommand,
  computerdInstallationStateCommand,
  containerToolchainBootstrapCommand,
  reusableComputerdProcess,
  runIdempotentBootstrapStage,
  strictSubshellCommand,
} from './container-toolchain';
import { CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS } from './operation-lease-policy';
import {
  CLOUDFLARE_API_PROXY_BASE_URL,
  CLOUDFLARE_API_PROXY_TOKEN,
} from '../../app/lib/.server/cloudflare/cloudflare-api-proxy';

describe('container toolchain bootstrap', () => {
  it('installs the pinned pnpm version and the credential-free cf launcher in one stage', () => {
    const command = containerToolchainBootstrapCommand("acc'1");

    expect(command).toMatch(/^\(\nset -eu\n[\s\S]+\n\)$/);
    expect(command).toContain('command -v pnpm');
    expect(command).toContain(`npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION}`);
    expect(command).toContain(`test "$(pnpm --version)" = '${GENERATED_PROJECT_PNPM_VERSION}'`);
    expect(command).toContain('--ignore-scripts');
    expect(command).toContain('--registry=https://registry.npmjs.org/');
    expect(command).toContain(`> '${CF_CLI_WRAPPER}'`);
    expect(command).toContain("> '/usr/local/bin/cloudchef'");
    // The only token in the container is the proxy's stand-in: never a credential.
    expect(command).not.toMatch(/Bearer/);
    const tokens = command.match(/CLOUDFLARE_API_TOKEN=[^\n]*/g) ?? [];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toContain(CLOUDFLARE_API_PROXY_TOKEN);
  });

  it('points cf at the proxy that holds the account’s authorization, with only a stand-in token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cf-launcher-'));
    const launcher = join(directory, 'cf');
    const root = join(directory, 'root');
    mkdirSync(join(root, CF_CLI_VERSION, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      join(root, CF_CLI_VERSION, 'node_modules', '.bin', 'cf'),
      '#!/bin/sh\necho "$CLOUDFLARE_API_BASE_URL|$CLOUDFLARE_API_TOKEN"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      launcher,
      cfCliLauncherScript('acc')
        .replaceAll('/opt/cloudchef/cf', root)
        .replaceAll('/home/project', join(directory, 'p')),
      { mode: 0o755 },
    );

    const run = spawnSync(launcher, ['workers', 'list'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(run.stdout).toBe(`${CLOUDFLARE_API_PROXY_BASE_URL}|${CLOUDFLARE_API_PROXY_TOKEN}\n`);
    expect(CLOUDFLARE_API_PROXY_BASE_URL).toBe('http://cloudflare-api.internal/client/v4');
  });

  it('says how `cloudchef validate` runs when it is reached as a program', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudchef-command-'));
    const command = join(directory, 'cloudchef');
    writeFileSync(command, cloudchefCommandScript(), { mode: 0o755 });

    const run = spawnSync(command, ['validate'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('as a command of its own, exactly as written');
  });

  it('runs the pinned cf, preferring the project copy, with the connected account', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cf-launcher-'));
    const launcher = join(directory, 'cf');
    const root = join(directory, 'root');
    const project = join(directory, 'project');
    const fakeCf = '#!/bin/sh\necho "$0|$CLOUDFLARE_ACCOUNT_ID|$*"\n';
    mkdirSync(join(root, CF_CLI_VERSION, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, CF_CLI_VERSION, 'node_modules', '.bin', 'cf'), fakeCf, { mode: 0o755 });
    writeFileSync(
      launcher,
      cfCliLauncherScript("acc'1").replaceAll('/opt/cloudchef/cf', root).replaceAll('/home/project', project),
      { mode: 0o755 },
    );

    const pinned = spawnSync(launcher, ['cli', 'search', 'list d1 databases'], { encoding: 'utf8' });
    expect(pinned.stdout).toBe(
      `${join(root, CF_CLI_VERSION, 'node_modules/.bin/cf')}|acc'1|cli search list d1 databases\n`,
    );

    mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(project, 'node_modules', '.bin', 'cf'), fakeCf, { mode: 0o755 });
    const local = spawnSync(launcher, ['schema', 'd1', 'list'], { encoding: 'utf8' });
    expect(local.stdout).toBe(`${join(project, 'node_modules/.bin/cf')}|acc'1|schema d1 list\n`);
  });

  it('reinstalls computerd when the pinned layer digest changes, not only when it is missing', () => {
    const command = computerdBootstrapCommand();

    expect(command).toMatch(/^\(\nset -eu\n[\s\S]+\n\)$/);
    // Existence alone would trust a computerd left by an earlier client version on a warm
    // container, whose exec protocol no longer matches — so gate on the recorded layer digest.
    expect(command).toContain(`if [ "$(cat '${COMPUTERD_ROOT}/.layer-digest' 2>/dev/null)" != 'sha256:`);
    expect(command).toContain(`rm -rf '${COMPUTERD_ROOT}'`);
    expect(command).toContain(`echo 'sha256:`);
    expect(command).toContain(`> '${COMPUTERD_ROOT}/.layer-digest'`);
    expect(command).toContain('ghcr.io/v2/cloudflare/computer-computerd-linux-x64/blobs/sha256:');
    expect(command).toContain(`test -x '${COMPUTERD_BINARY}'`);
  });

  it('checks the installed layer before reusing a live computerd process', async () => {
    const command = computerdInstallationStateCommand();
    const running = { status: async () => ({ state: 'running' }) };
    const exited = { status: async () => ({ state: 'exited' }) };
    let reads = 0;

    expect(command).toContain(`cat '${COMPUTERD_ROOT}/.layer-digest'`);
    expect(command).toContain(`-x '${COMPUTERD_BINARY}'`);
    expect(command).toContain(`printf %s '${COMPUTERD_INSTALLATION_CURRENT}'`);
    await expect(
      reusableComputerdProcess(running, async () => {
        reads += 1;
        return COMPUTERD_INSTALLATION_CURRENT;
      }),
    ).resolves.toBe(running);
    await expect(reusableComputerdProcess(running, async () => 'stale')).resolves.toBeNull();
    await expect(
      reusableComputerdProcess(exited, async () => {
        reads += 1;
        return COMPUTERD_INSTALLATION_CURRENT;
      }),
    ).resolves.toBeNull();
    await expect(reusableComputerdProcess(null, async () => COMPUTERD_INSTALLATION_CURRENT)).resolves.toBeNull();
    expect(reads).toBe(1);
  });

  it('derives the toolchain bootstrap bound from the shared package-install ceiling', () => {
    // The #131 defect was a bootstrap bound declared nowhere in this
    // repository (a hardcoded 30s vendor connect abort). The bootstrap is the
    // same class of work as a project dependency installation, so it shares
    // that ceiling instead of declaring another number.
    expect(CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS).toBe(CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS);
  });

  it('gives the vendor connect deadline room for every bootstrap stage it contains', () => {
    // CloudflareContainerBackend arms its connect deadline before host.start(),
    // so both bootstraps spend from the connect budget. A connect ceiling below
    // the stage budgets recreates the invisible shorter clock from #127/#131.
    expect(CONTAINER_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS + COMPUTERD_BOOTSTRAP_TIMEOUT_MS,
    );
  });

  it('keeps strict shell flags inside the bootstrap command', () => {
    const parent = spawnSync('/bin/sh', ['-c', `${strictSubshellCommand(['true'])}\nfalse\nprintf survived`], {
      encoding: 'utf8',
    });
    const child = spawnSync('/bin/sh', ['-c', strictSubshellCommand(['false', 'printf leaked'])], {
      encoding: 'utf8',
    });

    expect(parent.status).toBe(0);
    expect(parent.stdout).toBe('survived');
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
  });
});

describe('idempotent bootstrap retry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run `stage` to its end, firing its retry delays as they come due. */
  async function settle(stage: Promise<void>): Promise<Error | null> {
    const outcome = stage.then(
      () => null,
      (error: Error) => error,
    );
    await vi.runAllTimersAsync();
    return outcome;
  }

  it('retries a launch aborted by the vendor connect timeout and succeeds inside the budget', async () => {
    const starts: number[] = [];
    const budgets: number[] = [];
    let attempts = 0;

    const failure = await settle(
      runIdempotentBootstrapStage({
        stage: 'toolchain (pnpm)',
        budgetMs: 10 * 60_000,
        attempt: async (remainingMs) => {
          attempts += 1;
          starts.push(Date.now());
          budgets.push(remainingMs);
          // The production shape: the exec launch aborts after the hardcoded
          // 30s control-connection timeout while the container is starting.
          vi.advanceTimersByTime(30_000);
          if (attempts < 3) {
            throw new Error('The operation was aborted');
          }
        },
      }),
    );

    expect(failure).toBeNull();
    expect(attempts).toBe(3);
    expect(starts.slice(1).map((start, index) => start - starts[index]! - 30_000)).toEqual([
      BOOTSTRAP_RETRY_DELAY_MS,
      BOOTSTRAP_RETRY_DELAY_MS,
    ]);
    // Each attempt is offered only what is left of the one stage budget, so a
    // retry cannot quietly extend the ceiling.
    expect(budgets[0]).toBe(10 * 60_000);
    expect(budgets[1]).toBeLessThan(budgets[0]!);
    expect(budgets[2]).toBeLessThan(budgets[1]!);
  });

  it('names an exhausted bootstrap instead of surfacing a bare vendor abort', async () => {
    const failure = await settle(
      runIdempotentBootstrapStage({
        stage: 'toolchain (pnpm)',
        budgetMs: 60_000,
        attempt: async () => {
          vi.advanceTimersByTime(30_000);
          throw new Error('The operation was aborted');
        },
      }),
    );

    expect(failure).toBeInstanceOf(ContainerToolchainBootstrapError);
    const named = failure as ContainerToolchainBootstrapError;
    expect(named.name).toBe('ContainerToolchainBootstrapError');
    expect(named.stage).toBe('toolchain (pnpm)');
    expect(named.message).toContain('toolchain (pnpm)');
    expect(named.message).toContain('The operation was aborted');
    expect(named.message).toContain('retries it automatically');
    expect(named.cause).toBeInstanceOf(Error);
  });

  it('stops without another attempt once the budget cannot fit one', async () => {
    let attempts = 0;

    const failure = await settle(
      runIdempotentBootstrapStage({
        stage: 'computerd',
        budgetMs: 30_000 + BOOTSTRAP_RETRY_DELAY_MS,
        attempt: async () => {
          attempts += 1;
          vi.advanceTimersByTime(30_000);
          throw new Error('The operation was aborted');
        },
      }),
    );

    expect(failure).toBeInstanceOf(ContainerToolchainBootstrapError);
    expect(attempts).toBe(1);
  });

  it('does not retry a bootstrap that succeeded', async () => {
    let attempts = 0;

    await runIdempotentBootstrapStage({
      stage: 'computerd',
      budgetMs: 60_000,
      attempt: async () => {
        attempts += 1;
      },
    });

    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
