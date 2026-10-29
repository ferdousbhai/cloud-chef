import { z } from 'zod';
import { GENERATED_PROJECT_PNPM_VERSION } from '../../cloudchef-agent/cloudflare-computer';
import templatePackage from '../../template/package.json' with { type: 'json' };
import { WORKSPACE_MANAGED_IMAGE } from '../../app/lib/.server/cloudflare/user-workspace-image';
import { sha256Hex } from '../../app/lib/hex-digest';
import { ContainerProcesses, waitForContainerExec } from './container-process';
import { shellQuote } from './shell-quote';

/**
 * The base every workspace and project-builder container starts from, on the `durable_object` scheduling policy.
 *
 * Cloudflare's managed image (`cloudflare/debian-trixie`) carries Debian and Node 24 and nothing of CloudChef's. A
 * container's first start installs what CloudChef needs on top of it (the base setup below), and the runtime keeps
 * the whole filesystem as its base snapshot before anything of a person's is in it. Every later start of a workspace
 * or builder of the runtime restores that snapshot instead, which takes seconds rather than minutes. The snapshot is
 * found by a key naming everything it depends on (the managed image and the setup script with every pin in it), so
 * a release that changes either sets up once more and keeps a new one.
 *
 * What the runtime writes at each start (the git wrapper and hooks, the cf launcher, the `cloudchef` command,
 * container-toolchain.ts) is never in the snapshot, so it changes with the runtime, not with the base. Nothing a
 * person installs outside their project is either: each start restores the same base, so the terminal's tip that
 * such programs are gone after the workspace sleeps stays true.
 */

/** Node at the version `.nvmrc` pins for the generated projects, checked against nodejs.org's SHASUMS256.txt. */
export const BASE_NODE_VERSION = '26.3.0';
const BASE_NODE_SHA256 = '0ce210831380ab75a5fec0d3fb6b5af0958898016b2cae51cc2fa11057d2f77e';

/**
 * computerd, tagged with the @cloudflare/computer release whose protocol it speaks. Its image on GHCR is a single
 * layer holding only `usr/local/bin/computerd`, downloaded by that layer's digest and checked against it; it needs
 * no Node, and dlopens the system's libfuse 3.17 (trixie's fuse3) for a real FUSE mount, falling back to its
 * userspace shim where `/dev/fuse` is missing (`FUSE_MOUNT=auto`).
 */
export const BASE_COMPUTERD_VERSION = '0.8.0';
const BASE_COMPUTERD_REPOSITORY = 'cloudflare/computer-computerd-linux-x64';
const BASE_COMPUTERD_LAYER_DIGEST = 'sha256:5d673e54aa93e5ce6bed04dbe393aff31d04560cbd03abff574e4104422fedbc';
export const COMPUTERD_BINARY = '/usr/local/bin/computerd';

/** pnpm and the credential-free cf CLI, at the generated projects' own pins. */
const BASE_PNPM_VERSION = GENERATED_PROJECT_PNPM_VERSION;
const BASE_CF_CLI_VERSION = templatePackage.devDependencies.cf;

/**
 * The system packages the runtime's and the builder's own commands use: fuse3 for computerd's mount; git; tmux for
 * the person's terminal; coreutils' `timeout`, findutils' `find -printf`, procps' `pkill`, util-linux's `flock` and
 * `setpriv`, and passwd's `useradd`; curl, jq and the archive tools the setup and the projects' installs use.
 */
const BASE_SYSTEM_PACKAGES = [
  'ca-certificates',
  'coreutils',
  'curl',
  'findutils',
  'fuse3',
  'git',
  'jq',
  'passwd',
  'procps',
  'tar',
  'tmux',
  'unzip',
  'util-linux',
  'xz-utils',
  'zip',
] as const;

/** The person's terminal (workspace-terminal.ts): one shell, no tmux chrome. */
const TMUX_CONF = [
  'set -g status off',
  'set -g mouse on',
  'set -g history-limit 50000',
  'set -g default-terminal "xterm-256color"',
  'set -g escape-time 0',
  '',
].join('\n');

/** Where a set-up container records the key of the base it is, read back to recognise a restored snapshot. */
const BASE_KEY_FILE = '/opt/cloudchef/base-container-key';

/**
 * Written only once a start is ready for computerd, and never before a snapshot is taken, so a restored container
 * waits for it like a fresh one does.
 */
const COMPUTERD_START_MARKER = '/tmp/.cloudchef-start-computerd';

/**
 * The workspace container's entrypoint: wait for the runtime to say the container is ready, then become computerd.
 * computerd is not there yet on a fresh managed image, and the base setup must finish (and the snapshot be taken)
 * before computerd mounts the project at /home.
 */
export const COMPUTERD_ENTRYPOINT = [
  '/bin/sh',
  '-c',
  `while [ ! -e ${COMPUTERD_START_MARKER} ]; do sleep 0.2; done; exec ${COMPUTERD_BINARY}`,
] as const;

/** Tells a waiting entrypoint to start computerd. */
export const START_COMPUTERD_COMMAND = ['touch', COMPUTERD_START_MARKER] as const;

/** The builder's entrypoint: it runs its steps with `exec` and has no use for computerd. */
export const IDLE_ENTRYPOINT = ['sleep', 'infinity'] as const;

/** How long a container just started gets to accept its first command. */
const BASE_CONTAINER_EXEC_READY_TIMEOUT_MS = 2 * 60_000;
/**
 * The base setup's ceiling: a few apt packages, Node, pnpm, cf and computerd, all downloaded. It usually takes two to
 * four minutes; past this it has failed, and the next start sets up again.
 */
export const BASE_SETUP_TIMEOUT_MS = 10 * 60_000;
/** Everything one start may spend before computerd can be asked whether it is healthy. */
export const BASE_CONTAINER_START_BUDGET_MS = BASE_CONTAINER_EXEC_READY_TIMEOUT_MS * 2 + BASE_SETUP_TIMEOUT_MS;
/**
 * Cloudflare keeps a snapshot 30 days after it was taken or last restored. One not refreshed for longer than this is
 * not tried, so a start never waits on a restore that would be refused.
 */
export const BASE_SNAPSHOT_USABLE_MS = 29 * 24 * 60 * 60_000;
/** How long one start's claim to take the base snapshot holds off the others, longer than a setup can run. */
export const BASE_SETUP_CLAIM_LEASE_MS = BASE_SETUP_TIMEOUT_MS + 5 * 60_000;

function strictScript(lines: readonly string[]): string {
  return ['set -euo pipefail', ...lines].join('\n');
}

/** The base setup's commands, every pin in them, without the key they are named by. */
function baseSetupCommands(): string[] {
  const node = `node-v${BASE_NODE_VERSION}-linux-x64`;
  const cfRoot = `/opt/cloudchef/cf/${BASE_CF_CLI_VERSION}`;
  const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=repository:${BASE_COMPUTERD_REPOSITORY}:pull`;
  const layerUrl = `https://ghcr.io/v2/${BASE_COMPUTERD_REPOSITORY}/blobs/${BASE_COMPUTERD_LAYER_DIGEST}`;
  const npmFlags = '--ignore-scripts --no-audit --no-fund --loglevel=error --registry=https://registry.npmjs.org/';
  return [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    `apt-get install -y -qq --no-install-recommends ${BASE_SYSTEM_PACKAGES.join(' ')} >/dev/null`,
    'rm -rf /var/lib/apt/lists/*',
    "sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf",
    'ln -sf /proc/mounts /etc/mtab',
    'work="$(mktemp -d)"',
    // The managed image's Node 24 makes way for the pinned one, npm with it.
    `curl -fsSL --retry 3 -o "$work/node.tar.xz" ${shellQuote(`https://nodejs.org/dist/v${BASE_NODE_VERSION}/${node}.tar.xz`)}`,
    `echo ${shellQuote(`${BASE_NODE_SHA256}  `)}"$work/node.tar.xz" | sha256sum -c --quiet -`,
    'rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/include/node',
    'rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack',
    'tar -xJf "$work/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner',
    'rm -f /usr/local/CHANGELOG.md /usr/local/LICENSE /usr/local/README.md',
    `test "$(node --version)" = ${shellQuote(`v${BASE_NODE_VERSION}`)}`,
    `npm install --global pnpm@${BASE_PNPM_VERSION} ${npmFlags} >/dev/null`,
    `test "$(pnpm --version)" = ${shellQuote(BASE_PNPM_VERSION)}`,
    // Where the runtime's cf launcher looks for the pinned CLI before a project installs its own.
    `mkdir -p ${shellQuote(cfRoot)}`,
    `npm install --prefix ${shellQuote(cfRoot)} --no-save --omit=optional ${npmFlags} cf@${BASE_CF_CLI_VERSION} >/dev/null`,
    `test -x ${shellQuote(`${cfRoot}/node_modules/.bin/cf`)}`,
    `token="$(curl -fsSL --retry 3 ${shellQuote(tokenUrl)} | jq -er .token)"`,
    `curl -fsSL --retry 3 -H "Authorization: Bearer $token" -o "$work/computerd.tgz" ${shellQuote(layerUrl)}`,
    `echo ${shellQuote(`${BASE_COMPUTERD_LAYER_DIGEST.slice('sha256:'.length)}  `)}"$work/computerd.tgz" | sha256sum -c --quiet -`,
    `tar -xzf "$work/computerd.tgz" -C / --no-same-owner ${shellQuote(COMPUTERD_BINARY.slice(1))}`,
    `chmod 0755 ${shellQuote(COMPUTERD_BINARY)}`,
    `printf %s ${shellQuote(TMUX_CONF)} > /etc/tmux.conf`,
    'mkdir -p /opt/cloudchef/pnpm-store',
    // /home is computerd's mount point, and an existing /home/project is taken as proof the project is mounted
    // there: the managed image's own `node` user's home goes, and nothing of the setup is left in it.
    'find /home -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    'rm -rf "$work" /root/.npm /root/.cache',
    `rm -f ${shellQuote(COMPUTERD_START_MARKER)}`,
  ];
}

/** The base setup script, ending by recording the key it is named by, which a restore reads back. */
export function baseSetupScript(key: string): string {
  return strictScript([...baseSetupCommands(), `printf %s ${shellQuote(key)} > ${shellQuote(BASE_KEY_FILE)}`]);
}

let baseKey: Promise<string> | null = null;

/**
 * The key a base snapshot is kept under: the managed image and a digest of the setup script, which names every pin.
 * A release that changes either finds no snapshot of its own and sets up once more.
 */
export function baseSnapshotKey(): Promise<string> {
  baseKey ??= sha256Hex(`${WORKSPACE_MANAGED_IMAGE}\0${strictScript(baseSetupCommands())}`).then(
    (digest) => `${WORKSPACE_MANAGED_IMAGE}@setup-${digest}`,
  );
  return baseKey;
}

/** Every pin the base setup installs, for the checks that keep them in step with the repository. */
export const BASE_SETUP_PINS = {
  managedImage: WORKSPACE_MANAGED_IMAGE,
  node: BASE_NODE_VERSION,
  nodeSha256: BASE_NODE_SHA256,
  pnpm: BASE_PNPM_VERSION,
  cf: BASE_CF_CLI_VERSION,
  computerd: BASE_COMPUTERD_VERSION,
  computerdRepository: BASE_COMPUTERD_REPOSITORY,
  computerdLayerDigest: BASE_COMPUTERD_LAYER_DIGEST,
  systemPackages: BASE_SYSTEM_PACKAGES,
} as const;

const snapshotRowSchema = z.object({
  snapshot_id: z.string().min(1).nullable(),
  refreshed_at: z.number().nullable(),
});

/** The base snapshot the runtime keeps for a key: its handle, and when Cloudflare's 30 days last started over. */
export type BaseSnapshotRecord = { snapshotId: string | null; refreshedAt: number | null };

/** How a start begins: by restoring the base snapshot, or by setting up from the managed image. */
export type BaseStartPlan = { kind: 'restore'; snapshotId: string } | { kind: 'setup' };

/** A snapshot is restored while Cloudflare still keeps it; anything else, or none, means setting up. */
export function chooseBaseStart(record: BaseSnapshotRecord | null, now: number): BaseStartPlan {
  if (record?.snapshotId && record.refreshedAt !== null && now - record.refreshedAt < BASE_SNAPSHOT_USABLE_MS) {
    return { kind: 'restore', snapshotId: record.snapshotId };
  }
  return { kind: 'setup' };
}

/**
 * The runtime's base snapshots, in its own D1 (`user-workspace-migrations/0023_base_container_snapshots.sql`), where
 * every workspace and the project builder of the runtime read the same handle. Only one start at a time may take a
 * snapshot for a key: it claims the right first, and the others set up for themselves meanwhile.
 */
export class BaseSnapshotStore {
  constructor(private readonly db: Pick<D1Database, 'prepare'>) {}

  async find(key: string): Promise<BaseSnapshotRecord | null> {
    const row = await this.db
      .prepare('SELECT snapshot_id, refreshed_at FROM base_container_snapshots WHERE snapshot_key = ?')
      .bind(key)
      .first();
    if (row === null) {
      return null;
    }
    const parsed = snapshotRowSchema.parse(row);
    return { snapshotId: parsed.snapshot_id, refreshedAt: parsed.refreshed_at };
  }

  /**
   * Claim the right to take the snapshot for `key`: granted when there is no usable one and no other start holds an
   * unexpired claim. A claim left by a start that stopped partway lapses after `BASE_SETUP_CLAIM_LEASE_MS`.
   */
  async claim(key: string, holder: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO base_container_snapshots (snapshot_key, setup_holder, setup_claimed_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(snapshot_key) DO UPDATE SET
           setup_holder = excluded.setup_holder,
           setup_claimed_at = excluded.setup_claimed_at
         WHERE (base_container_snapshots.snapshot_id IS NULL OR base_container_snapshots.refreshed_at <= ?4)
           AND (base_container_snapshots.setup_holder IS NULL OR base_container_snapshots.setup_claimed_at <= ?5)`,
      )
      .bind(key, holder, now, now - BASE_SNAPSHOT_USABLE_MS, now - BASE_SETUP_CLAIM_LEASE_MS)
      .run();
    return result.meta.changes === 1;
  }

  /** Keep the snapshot the claim's holder took, and forget the bases of every other key. */
  async record(key: string, holder: string, snapshot: { id: string; size: number }, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE base_container_snapshots
         SET snapshot_id = ?, snapshot_size = ?, taken_at = ?, refreshed_at = ?, setup_holder = NULL,
             setup_claimed_at = NULL
         WHERE snapshot_key = ? AND setup_holder = ?`,
      )
      .bind(snapshot.id, snapshot.size, now, now, key, holder)
      .run();
    await this.db.prepare('DELETE FROM base_container_snapshots WHERE snapshot_key <> ?').bind(key).run();
    return result.meta.changes === 1;
  }

  /** Give up a claim whose snapshot could not be taken, so another start may try. */
  async release(key: string, holder: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE base_container_snapshots SET setup_holder = NULL, setup_claimed_at = NULL
         WHERE snapshot_key = ? AND setup_holder = ?`,
      )
      .bind(key, holder)
      .run();
  }

  /** A restore starts Cloudflare's 30 days over. */
  async refreshed(key: string, snapshotId: string, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE base_container_snapshots SET refreshed_at = ? WHERE snapshot_key = ? AND snapshot_id = ?')
      .bind(now, key, snapshotId)
      .run();
  }

  /** Forget a snapshot that could not be restored, unless another start has kept a newer one meanwhile. */
  async discard(key: string, snapshotId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE base_container_snapshots SET snapshot_id = NULL, snapshot_size = NULL, refreshed_at = NULL
         WHERE snapshot_key = ? AND snapshot_id = ?`,
      )
      .bind(key, snapshotId)
      .run();
  }
}

type BaseContainer = Pick<Container, 'start' | 'exec' | 'snapshotContainer' | 'destroy' | 'running'>;

/** What every start of one container asks for besides the image or snapshot it comes from. */
export type BaseContainerStartOptions = {
  entrypoint: readonly string[];
  env: Record<string, string>;
  enableInternet: boolean;
  instance: NonNullable<ContainerStartupOptions['instance']>;
};

export type BaseContainerStart = { source: 'snapshot' | 'setup'; snapshotTaken: boolean };

/**
 * Start `container` on the runtime's base: restore the base snapshot when one is kept for this release's key, or
 * start the managed image, set it up, and (when this start wins the claim) keep the result as the base snapshot. A
 * snapshot that cannot be restored, or turns out not to be this key's base, is forgotten and the start sets up.
 * The container is left running with its entrypoint waiting, as it was given.
 */
export async function startBaseContainer(args: {
  container: BaseContainer;
  store: BaseSnapshotStore;
  /** Names this start's claim on taking the snapshot. */
  holder: string;
  options: BaseContainerStartOptions;
  now?: () => number;
}): Promise<BaseContainerStart> {
  const now = args.now ?? Date.now;
  const key = await baseSnapshotKey();
  const { container, store } = args;
  const common: Omit<ContainerStartupOptions, 'image' | 'containerSnapshot'> = {
    entrypoint: [...args.options.entrypoint],
    enableInternet: args.options.enableInternet,
    env: args.options.env,
    instance: args.options.instance,
  };
  const plan = chooseBaseStart(await store.find(key), now());
  if (plan.kind === 'restore') {
    try {
      container.start({ ...common, containerSnapshot: { id: plan.snapshotId } });
      await waitForContainerExec(container, BASE_CONTAINER_EXEC_READY_TIMEOUT_MS);
      if ((await readContainerText(container, ['cat', BASE_KEY_FILE])) !== key) {
        throw new Error('The restored container is not this release’s base.');
      }
      await store.refreshed(key, plan.snapshotId, now());
      return { source: 'snapshot', snapshotTaken: false };
    } catch (error) {
      console.warn({
        event: 'base_snapshot_restore_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      await store.discard(key, plan.snapshotId);
      if (container.running) {
        await container.destroy().catch(() => undefined);
      }
    }
  }
  container.start({ ...common, image: WORKSPACE_MANAGED_IMAGE });
  await waitForContainerExec(container, BASE_CONTAINER_EXEC_READY_TIMEOUT_MS);
  await runBaseSetup(container, key);
  if (!(await store.claim(key, args.holder, now()))) {
    return { source: 'setup', snapshotTaken: false };
  }
  try {
    const snapshot = await container.snapshotContainer({ name: `cloudchef-base-${key.slice(-16)}` });
    const kept = await store.record(key, args.holder, snapshot, now());
    console.info({ event: 'base_snapshot_taken', size: snapshot.size, kept });
    return { source: 'setup', snapshotTaken: kept };
  } catch (error) {
    console.warn({ event: 'base_snapshot_failed', error: error instanceof Error ? error.message : String(error) });
    await store.release(key, args.holder);
    return { source: 'setup', snapshotTaken: false };
  }
}

async function runBaseSetup(container: BaseContainer, key: string): Promise<void> {
  const startedAt = Date.now();
  const process = await new ContainerProcesses(
    async () => container,
    () => null,
  ).exec(['/bin/bash', '-c', baseSetupScript(key)], { timeout: BASE_SETUP_TIMEOUT_MS, env: { HOME: '/root' } });
  const output = await process.output({
    encoding: 'utf8',
    maxBytes: 8 * 1024,
    timeout: BASE_SETUP_TIMEOUT_MS + 30_000,
  });
  if (output.exitCode !== 0) {
    throw new Error(
      `The container's base setup ${output.timedOut ? 'did not finish in time' : `failed (exit ${output.exitCode})`}: ${output.stderr.trim().slice(-2_000)}`,
    );
  }
  console.info({ event: 'base_setup_completed', durationMs: Date.now() - startedAt });
}

/** A short command's whole stdout, which must succeed. */
async function readContainerText(container: Pick<Container, 'exec'>, command: string[]): Promise<string> {
  const process = await container.exec(command, { stdout: 'pipe', stderr: 'ignore' });
  const [code, text] = await Promise.all([process.exitCode, new Response(process.stdout).text()]);
  if (code !== 0) {
    throw new Error(`${command[0]} exited ${code}.`);
  }
  return text;
}
