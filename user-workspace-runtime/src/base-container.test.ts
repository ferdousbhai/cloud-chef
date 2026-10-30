import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userWorkspaceDatabase } from '../../app/test/control-plane-d1';
import { GENERATED_PROJECT_PNPM_VERSION } from '../../cloudchef-agent/cloudflare-computer';
import templatePackage from '../../template/package.json' with { type: 'json' };
import rootPackage from '../../package.json' with { type: 'json' };
import {
  BASE_COMPUTERD_VERSION,
  BASE_NODE_VERSION,
  BASE_SETUP_CLAIM_LEASE_MS,
  BASE_SETUP_PINS,
  BASE_SNAPSHOT_USABLE_MS,
  BaseSnapshotStore,
  baseSetupScript,
  baseSnapshotKey,
  chooseBaseStart,
  COMPUTERD_ENTRYPOINT,
  START_COMPUTERD_COMMAND,
  startBaseContainer,
} from './base-container';

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60_000;

describe('choosing how a container starts', () => {
  it('restores the base snapshot kept for this key while Cloudflare still keeps it', () => {
    expect(chooseBaseStart({ snapshotId: 'snap-1', refreshedAt: NOW - 3 * DAY }, NOW)).toEqual({
      kind: 'restore',
      snapshotId: 'snap-1',
    });
  });

  it('sets up when there is none for this key, or only a claim to take one', () => {
    expect(chooseBaseStart(null, NOW)).toEqual({ kind: 'setup' });
    expect(chooseBaseStart({ snapshotId: null, refreshedAt: null }, NOW)).toEqual({ kind: 'setup' });
  });

  it('sets up rather than try a snapshot whose 30 days may have run out', () => {
    expect(chooseBaseStart({ snapshotId: 'snap-1', refreshedAt: NOW - BASE_SNAPSHOT_USABLE_MS }, NOW)).toEqual({
      kind: 'setup',
    });
    expect(BASE_SNAPSHOT_USABLE_MS).toBeLessThan(30 * DAY);
  });
});

describe('the base snapshot store', () => {
  const KEY = 'cloudflare/debian-trixie@setup-abc';

  it('lets only one start claim the snapshot, until its claim lapses', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);

    await expect(store.claim(KEY, 'first', NOW)).resolves.toBe(true);
    await expect(store.claim(KEY, 'second', NOW + 1_000)).resolves.toBe(false);
    await expect(store.claim(KEY, 'second', NOW + BASE_SETUP_CLAIM_LEASE_MS)).resolves.toBe(true);
    // The lapsed holder can no longer record what it took.
    await expect(store.record(KEY, 'first', { id: 'snap-1', size: 1 }, NOW)).resolves.toBe(false);
    await expect(store.record(KEY, 'second', { id: 'snap-2', size: 1 }, NOW)).resolves.toBe(true);
    await expect(store.find(KEY)).resolves.toEqual({ snapshotId: 'snap-2', refreshedAt: NOW });
  });

  it('refuses a claim while a usable snapshot is kept, and allows one once it may have expired', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    await store.claim(KEY, 'first', NOW);
    await store.record(KEY, 'first', { id: 'snap-1', size: 1 }, NOW);

    await expect(store.claim(KEY, 'second', NOW + DAY)).resolves.toBe(false);
    await store.refreshed(KEY, 'snap-1', NOW + 20 * DAY);
    await expect(store.claim(KEY, 'second', NOW + 40 * DAY)).resolves.toBe(false);
    await expect(store.claim(KEY, 'second', NOW + 20 * DAY + BASE_SNAPSHOT_USABLE_MS)).resolves.toBe(true);
  });

  it('forgets a refused snapshot only if it is still the one kept, and a released claim frees the key', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    await store.claim(KEY, 'first', NOW);
    await store.record(KEY, 'first', { id: 'snap-1', size: 1 }, NOW);

    await store.discard(KEY, 'snap-other');
    await expect(store.find(KEY)).resolves.toEqual({ snapshotId: 'snap-1', refreshedAt: NOW });
    await store.discard(KEY, 'snap-1');
    await expect(store.find(KEY)).resolves.toEqual({ snapshotId: null, refreshedAt: null });

    await expect(store.claim(KEY, 'second', NOW)).resolves.toBe(true);
    await store.release(KEY, 'second');
    await expect(store.claim(KEY, 'third', NOW)).resolves.toBe(true);
  });

  it('keeps only the current key once a new base is recorded', async () => {
    const { db } = userWorkspaceDatabase();
    const store = new BaseSnapshotStore(db);
    await store.claim('earlier-key', 'first', NOW);
    await store.record('earlier-key', 'first', { id: 'snap-old', size: 1 }, NOW);
    await store.claim(KEY, 'second', NOW);
    await store.record(KEY, 'second', { id: 'snap-new', size: 1 }, NOW);

    await expect(store.find('earlier-key')).resolves.toBeNull();
    await expect(store.find(KEY)).resolves.toEqual({ snapshotId: 'snap-new', refreshedAt: NOW });
  });
});

/**
 * A container on the Container API, with a filesystem of one fact: the base key a set-up container records. The base
 * setup records the key it was given; a snapshot keeps what the filesystem held; a restore of an unknown or
 * withdrawn snapshot is refused as Cloudflare refuses an expired one.
 */
class FakeContainer {
  running = false;
  keyFile: string | null = null;
  readonly starts: ContainerStartupOptions[] = [];
  readonly snapshots = new Map<string, string | null>();
  readonly setups: string[] = [];
  snapshotFails = false;
  #setupGate: Promise<void> = Promise.resolve();
  #openSetups: () => void = () => undefined;

  /** Hold every base setup until `releaseSetups`, as setups that overlap in time. */
  holdSetups(): void {
    this.#setupGate = new Promise((resolve) => {
      this.#openSetups = resolve;
    });
  }

  releaseSetups(): void {
    this.#openSetups();
  }

  start(options?: ContainerStartupOptions): void {
    if (!options) {
      throw new Error('A durable_object start names its image or snapshot.');
    }
    this.starts.push(options);
    if (options.containerSnapshot) {
      const kept = this.snapshots.get(options.containerSnapshot.id);
      if (kept === undefined) {
        throw new Error('snapshot not found');
      }
      this.keyFile = kept;
    } else {
      this.keyFile = null;
    }
    this.running = true;
  }

  async destroy(): Promise<void> {
    this.running = false;
  }

  async snapshotContainer(options?: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    if (this.snapshotFails) {
      throw new Error('snapshot failed');
    }
    const id = `snap-${this.snapshots.size + 1}`;
    this.snapshots.set(id, this.keyFile);
    return options?.name ? { id, size: 1_000, name: options.name } : { id, size: 1_000 };
  }

  async exec(command: string[]): Promise<ExecProcess> {
    const script = command.at(-1) ?? '';
    if (command.includes('/bin/bash') && script.includes('apt-get install')) {
      this.setups.push(script);
      await this.#setupGate;
      this.keyFile = /printf %s '([^']+)' > '\/opt\/cloudchef\/base-container-key'$/.exec(script)?.[1] ?? null;
      return execProcess(0, '');
    }
    if (command[0] === 'cat') {
      return this.keyFile === null ? execProcess(1, '') : execProcess(0, this.keyFile);
    }
    return execProcess(0, '');
  }
}

function execProcess(code: number, stdout: string): ExecProcess {
  const stream = (text: string) => new Blob([text]).stream();
  return {
    stdin: null,
    stdout: stream(stdout),
    stderr: stream(''),
    pid: 100,
    isPty: false,
    exitCode: Promise.resolve(code),
    output: async () => ({
      stdout: new ArrayBuffer(0),
      stderr: new ArrayBuffer(0),
      exitCode: code,
    }),
    kill: () => undefined,
    resize: () => undefined,
  };
}

describe('starting a container on the base', () => {
  const options = { entrypoint: COMPUTERD_ENTRYPOINT, env: {}, enableInternet: true, instance: 'standard-4' as const };

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets up the managed image on a first start and keeps the base snapshot, which the next start restores', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    const first = new FakeContainer();

    await expect(
      startBaseContainer({ container: first, store, holder: 'a', options, now: () => NOW }),
    ).resolves.toEqual({ source: 'setup', snapshotTaken: true });
    expect(first.starts[0]).toMatchObject({
      image: 'cloudflare/debian-trixie',
      enableInternet: true,
      instance: 'standard-4',
      entrypoint: [...COMPUTERD_ENTRYPOINT],
    });
    expect(first.setups).toHaveLength(1);

    // Another workspace (or the builder) of the runtime, with the snapshot the first took.
    const second = new FakeContainer();
    second.snapshots.set('snap-1', first.snapshots.get('snap-1') ?? null);
    await expect(
      startBaseContainer({ container: second, store, holder: 'b', options, now: () => NOW + DAY }),
    ).resolves.toEqual({ source: 'snapshot', snapshotTaken: false });
    expect(second.starts).toEqual([
      expect.objectContaining({ containerSnapshot: { id: 'snap-1' }, enableInternet: true, instance: 'standard-4' }),
    ]);
    expect(second.starts[0]).not.toHaveProperty('image');
    expect(second.setups).toHaveLength(0);
    // The restore started Cloudflare's 30 days over.
    await expect(store.find(await baseSnapshotKey())).resolves.toEqual({
      snapshotId: 'snap-1',
      refreshedAt: NOW + DAY,
    });
  });

  it('sets up again when the kept snapshot turns out not to be this release’s base', async () => {
    const { db } = userWorkspaceDatabase();
    const store = new BaseSnapshotStore(db);
    const key = await baseSnapshotKey();
    await store.claim(key, 'earlier', NOW);
    await store.record(key, 'earlier', { id: 'snap-stale', size: 1 }, NOW);
    const container = new FakeContainer();
    container.snapshots.set('snap-stale', 'some-other-base');

    await expect(startBaseContainer({ container, store, holder: 'a', options, now: () => NOW + DAY })).resolves.toEqual(
      { source: 'setup', snapshotTaken: true },
    );

    expect(container.starts.map((start) => (start.containerSnapshot ? 'restore' : start.image))).toEqual([
      'restore',
      'cloudflare/debian-trixie',
    ]);
    await expect(store.find(key)).resolves.toEqual({ snapshotId: 'snap-2', refreshedAt: NOW + DAY });
  });

  it('sets up when Cloudflare refuses the snapshot, as an expired one', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    const key = await baseSnapshotKey();
    await store.claim(key, 'earlier', NOW);
    await store.record(key, 'earlier', { id: 'snap-gone', size: 1 }, NOW);
    const container = new FakeContainer();

    await expect(startBaseContainer({ container, store, holder: 'a', options, now: () => NOW + DAY })).resolves.toEqual(
      { source: 'setup', snapshotTaken: true },
    );
    expect(container.setups).toHaveLength(1);
  });

  it('does not try a snapshot past its 30 days, and replaces it', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    const key = await baseSnapshotKey();
    await store.claim(key, 'earlier', NOW);
    await store.record(key, 'earlier', { id: 'snap-old', size: 1 }, NOW);
    const container = new FakeContainer();
    const later = NOW + 31 * DAY;

    await expect(startBaseContainer({ container, store, holder: 'a', options, now: () => later })).resolves.toEqual({
      source: 'setup',
      snapshotTaken: true,
    });
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0]).toMatchObject({ image: 'cloudflare/debian-trixie' });
    await expect(store.find(key)).resolves.toEqual({ snapshotId: 'snap-1', refreshedAt: later });
  });

  it('lets concurrent first starts all set up, and only one of them take the snapshot', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    const containers = [new FakeContainer(), new FakeContainer(), new FakeContainer()];
    for (const container of containers) {
      container.holdSetups();
    }

    const starts = containers.map((container, index) =>
      startBaseContainer({ container, store, holder: `start-${index}`, options, now: () => NOW }),
    );
    await vi.waitFor(() => expect(containers.every((container) => container.setups.length === 1)).toBe(true));
    for (const container of containers) {
      container.releaseSetups();
    }
    const results = await Promise.all(starts);

    expect(results.filter((result) => result.snapshotTaken)).toHaveLength(1);
    expect(results.every((result) => result.source === 'setup')).toBe(true);
    expect(containers.reduce((taken, container) => taken + container.snapshots.size, 0)).toBe(1);
  });

  it('gives up its claim when the snapshot cannot be taken, so the next start may', async () => {
    const store = new BaseSnapshotStore(userWorkspaceDatabase().db);
    const failing = new FakeContainer();
    failing.snapshotFails = true;

    await expect(
      startBaseContainer({ container: failing, store, holder: 'a', options, now: () => NOW }),
    ).resolves.toEqual({ source: 'setup', snapshotTaken: false });
    await expect(
      startBaseContainer({ container: new FakeContainer(), store, holder: 'b', options, now: () => NOW + 1 }),
    ).resolves.toEqual({ source: 'setup', snapshotTaken: true });
  });
});

describe('the base setup', { timeout: 30_000 }, () => {
  it('installs the pins this checkout keeps: .nvmrc’s Node, Computer’s computerd, the projects’ pnpm and cf', () => {
    const nvmrc = readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim();
    expect(BASE_NODE_VERSION).toBe(nvmrc);
    expect(BASE_COMPUTERD_VERSION).toBe(rootPackage.dependencies['@cloudflare/computer']);
    expect(BASE_SETUP_PINS.pnpm).toBe(GENERATED_PROJECT_PNPM_VERSION);
    expect(BASE_SETUP_PINS.cf).toBe(templatePackage.devDependencies.cf);

    const script = baseSetupScript('key');
    expect(script).toContain(`https://nodejs.org/dist/v${nvmrc}/node-v${nvmrc}-linux-x64.tar.xz`);
    expect(script).toContain(`${BASE_SETUP_PINS.nodeSha256}  `);
    expect(script).toContain(`pnpm@${GENERATED_PROJECT_PNPM_VERSION} `);
    expect(script).toContain(`cf@${templatePackage.devDependencies.cf} `);
    expect(script).toContain(`/blobs/${BASE_SETUP_PINS.computerdLayerDigest}`);
    expect(script).toContain(`${BASE_SETUP_PINS.computerdLayerDigest.slice('sha256:'.length)}  `);
    for (const tool of ['fuse3', 'git', 'tmux', 'procps', 'util-linux', 'passwd']) {
      expect(BASE_SETUP_PINS.systemPackages).toContain(tool);
    }
  });

  it('is a strict bash script that records its key last', () => {
    const script = baseSetupScript("key-with-'quote'");
    expect(script.startsWith('set -euo pipefail\n')).toBe(true);
    expect(spawnSync('bash', ['-n', '-c', script]).status).toBe(0);
    expect(script.endsWith(`printf %s 'key-with-'\\''quote'\\''' > '/opt/cloudchef/base-container-key'`)).toBe(true);
    // Nothing tells computerd to start inside the base, and /home is left empty for its mount.
    expect(script).toContain("rm -f '/tmp/.cloudchef-start-computerd'");
    expect(script).toContain('find /home -mindepth 1 -maxdepth 1 -exec rm -rf {} +');
  });

  it('is named by the managed image and a digest of everything the setup installs', async () => {
    const key = await baseSnapshotKey();
    expect(key).toMatch(/^cloudflare\/debian-trixie@setup-[a-f0-9]{64}$/);
    await expect(baseSnapshotKey()).resolves.toBe(key);
  });

  it('starts computerd only once the runtime says the container is ready', () => {
    const directory = mkdtempSync(join(tmpdir(), 'computerd-entrypoint-'));
    const marker = join(directory, 'start');
    const entrypoint = COMPUTERD_ENTRYPOINT[2]
      .replace(START_COMPUTERD_COMMAND[1], marker)
      .replace('exec /usr/local/bin/computerd', 'echo started');

    // The marker is never in a fresh or restored container, so the entrypoint is still waiting.
    const waiting = spawnSync('/bin/sh', ['-c', entrypoint], { encoding: 'utf8', timeout: 500 });
    expect(waiting.stdout).toBe('');
    expect(waiting.error).toBeDefined();

    writeFileSync(marker, '');
    expect(spawnSync('/bin/sh', ['-c', entrypoint], { encoding: 'utf8', timeout: 5_000 }).stdout).toBe('started\n');
  });
});
