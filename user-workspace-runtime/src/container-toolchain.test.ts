import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GENERATED_PROJECT_PNPM_VERSION } from '../../cloudchef-agent/cloudflare-computer';
import {
  BOOTSTRAP_RETRY_DELAY_MS,
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

describe('container toolchain bootstrap', () => {
  it('installs and verifies the pinned pnpm version missing from the stock Sandbox image', () => {
    const command = containerToolchainBootstrapCommand();

    expect(command).toMatch(/^\(\nset -eu\n[\s\S]+\n\)$/);
    expect(command).toContain('command -v pnpm');
    expect(command).toContain(`npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION}`);
    expect(command).toContain(`test "$(pnpm --version)" = '${GENERATED_PROJECT_PNPM_VERSION}'`);
    expect(command).toContain('--ignore-scripts');
    expect(command).toContain('--registry=https://registry.npmjs.org/');
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
  function fakeClock() {
    let time = 0;
    return {
      now: () => time,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  it('retries a launch aborted by the vendor connect timeout and succeeds inside the budget', async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    const budgets: number[] = [];
    let attempts = 0;

    await runIdempotentBootstrapStage({
      stage: 'toolchain (pnpm)',
      budgetMs: 10 * 60_000,
      attempt: async (remainingMs) => {
        attempts += 1;
        budgets.push(remainingMs);
        // The production shape: the exec launch aborts after the hardcoded
        // 30s control-connection timeout while the container is starting.
        clock.advance(30_000);
        if (attempts < 3) {
          throw new Error('The operation was aborted');
        }
      },
      now: clock.now,
      delay: async (ms) => {
        delays.push(ms);
        clock.advance(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(delays).toEqual([BOOTSTRAP_RETRY_DELAY_MS, BOOTSTRAP_RETRY_DELAY_MS]);
    // Each attempt is offered only what is left of the one stage budget, so a
    // retry cannot quietly extend the ceiling.
    expect(budgets[0]).toBe(10 * 60_000);
    expect(budgets[1]).toBeLessThan(budgets[0]!);
    expect(budgets[2]).toBeLessThan(budgets[1]!);
  });

  it('names an exhausted bootstrap instead of surfacing a bare vendor abort', async () => {
    const clock = fakeClock();

    const failure = await runIdempotentBootstrapStage({
      stage: 'toolchain (pnpm)',
      budgetMs: 60_000,
      attempt: async () => {
        clock.advance(30_000);
        throw new Error('The operation was aborted');
      },
      now: clock.now,
      delay: async (ms) => clock.advance(ms),
    }).then(
      () => null,
      (error: unknown) => error,
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
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      runIdempotentBootstrapStage({
        stage: 'computerd',
        budgetMs: 30_000 + BOOTSTRAP_RETRY_DELAY_MS,
        attempt: async () => {
          attempts += 1;
          clock.advance(30_000);
          throw new Error('The operation was aborted');
        },
        now: clock.now,
        delay: async (ms) => clock.advance(ms),
      }),
    ).rejects.toBeInstanceOf(ContainerToolchainBootstrapError);

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
      now: () => 0,
      delay: async () => {
        throw new Error('a successful bootstrap must not sleep');
      },
    });

    expect(attempts).toBe(1);
  });
});
