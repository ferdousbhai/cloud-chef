import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerLaunchSpec } from '@cloudflare/computer/backends/container';
import { ManagedWorkspaceContainerHost } from './computer-sandbox';

const SPEC = { env: { PORT: '8080', MOUNT_POINT: '/home' }, enableInternet: true, instance: 'standard-4' as const };

/** The Container API as the host sees it: running or not, and a monitor that settles when the container exits. */
class FakeContainer {
  running = false;
  destroyed = 0;
  #exit: () => void = () => undefined;

  monitor(): Promise<void> {
    return new Promise((resolve) => {
      this.#exit = resolve;
    });
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
    this.running = false;
    this.#exit();
  }

  /** The container stops on its own, as the platform stops an idle one. */
  stopOnItsOwn(): void {
    this.running = false;
    this.#exit();
  }

  async setInactivityTimeout(): Promise<void> {}

  getTcpPort(): Fetcher {
    return {
      fetch: async () => new Response('ok'),
      connect: () => {
        throw new Error('not used');
      },
    };
  }
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key),
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
  };
}

function host(container: FakeContainer, storage = memoryStorage()) {
  let runtime: string | null = null;
  let launches = 0;
  const launch = vi.fn(async (_spec: ContainerLaunchSpec, secret: string) => {
    expect(secret).toMatch(/^[a-f0-9]{32}$/);
    container.running = true;
    launches += 1;
    runtime = `runtime-${launches}`;
    return runtime;
  });
  const managed = new ManagedWorkspaceContainerHost(container, storage, {
    launch,
    adopted: () => runtime,
    intercept: async () => undefined,
  });
  return { managed, launch, storage };
}

describe('the workspace container host', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('launches a stopped container, and adopts it while it runs as it was launched', async () => {
    const container = new FakeContainer();
    const { managed, launch } = host(container);

    const first = await managed.start(SPEC);
    expect(first).toMatchObject({ runtimeId: 'runtime-1', outcome: 'launched' });
    const again = await managed.start(SPEC);
    expect(again).toEqual({ runtimeId: 'runtime-1', clientSecret: first.clientSecret, outcome: 'adopted' });
    expect(launch).toHaveBeenCalledOnce();
  });

  it('relaunches a running container started with a different environment', async () => {
    const container = new FakeContainer();
    const { managed, launch } = host(container);
    await managed.start(SPEC);

    await expect(managed.start({ ...SPEC, env: { ...SPEC.env, EXTRA: '1' } })).resolves.toMatchObject({
      runtimeId: 'runtime-2',
      outcome: 'relaunched',
    });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(container.destroyed).toBe(1);
  });

  it('records a container that stopped on its own, and launches a new one next', async () => {
    const container = new FakeContainer();
    const { managed } = host(container);
    await managed.start(SPEC);

    container.stopOnItsOwn();
    await vi.waitFor(async () => expect(await managed.exitInfo()).toMatchObject({ reason: 'exited normally' }));
    await expect(managed.fetchPort(8080, 'http://container/health')).rejects.toThrow('container exited');
    await expect(managed.start(SPEC)).resolves.toMatchObject({ runtimeId: 'runtime-2', outcome: 'launched' });
    await expect(managed.exitInfo()).resolves.toBeNull();
  });

  it('never adopts a container a launch left partway, and stops it', async () => {
    const container = new FakeContainer();
    const { managed, launch, storage } = host(container);
    launch.mockImplementationOnce(async () => {
      container.running = true;
      throw new Error('base setup failed');
    });

    await expect(managed.start(SPEC)).rejects.toThrow('base setup failed');
    expect(container.running).toBe(false);
    expect(storage.values.has('cloudchef:container-launch-digest')).toBe(false);
    await expect(managed.start(SPEC)).resolves.toMatchObject({ outcome: 'launched' });
  });

  it('keeps one client secret for the workspace across launches', async () => {
    const container = new FakeContainer();
    const storage = memoryStorage();
    const first = await host(container, storage).managed.start(SPEC);
    container.stopOnItsOwn();
    // A new instance of the Durable Object, after a restart.
    const second = await host(container, storage).managed.start(SPEC);

    expect(second.clientSecret).toBe(first.clientSecret);
  });
});
