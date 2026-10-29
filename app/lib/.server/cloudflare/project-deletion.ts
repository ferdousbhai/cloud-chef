import type { Project } from '~/lib/cloudflare/data/org-projects.server';
import { isCloudChefResourceName } from './deploy-api-policy';
import type { AccountQueue, UserCloudflareAccountApi, WorkerBinding } from './user-account-api';
import { findProjectWorker } from './workers-builds';

/** What deleting a project uses of the account API. */
export type ProjectDeletionApi = Pick<
  UserCloudflareAccountApi,
  | 'listWorkerScripts'
  | 'latestWorkersBuilds'
  | 'listWorkersBuildTriggers'
  | 'deleteWorkersBuildTrigger'
  | 'workerBindings'
  | 'd1DatabaseName'
  | 'kvNamespaceTitle'
  | 'deleteManagedWorker'
  | 'deleteD1DatabaseById'
  | 'deleteKvNamespaceById'
  | 'deleteR2Bucket'
  | 'listQueues'
  | 'deleteQueueById'
  | 'vectorizeIndexExists'
  | 'deleteVectorizeIndex'
  | 'hyperdriveConfigName'
  | 'deleteHyperdriveConfig'
>;

/** A resource a project's Workers bind that deleting it removes, or keeps (`reason`). */
type DeletionResource = {
  /** A D1 database, R2 bucket, KV namespace, queue, Vectorize index, Hyperdrive config, or another kind. */
  kind: 'database' | 'storage' | 'keys' | 'queue' | 'vectors' | 'connection' | 'other';
  /** The database's, namespace's, queue's or config's id, the bucket's or index's name, or the other one's name. */
  id: string;
  /** How people know it: the database's, queue's or config's name, the namespace's title, the bucket's name. */
  name: string;
};

/** Everything deleting a project removes from its account, and what it leaves because something else uses it. */
type ProjectDeletionPlan = {
  /** The project's site addresses, as CloudChef recorded them. */
  sites: string[];
  /** The Workers its site runs on; each goes with its versions, previews and Durable Objects. */
  workers: string[];
  /**
   * The Workers Builds triggers that build it from its repository, removed before its Worker: deleting a Worker isn't
   * documented to remove them. Empty for a project CloudChef publishes itself.
   */
  buildTriggers: string[];
  resources: DeletionResource[];
  kept: (DeletionResource & { reason: string })[];
  /** Its Artifacts repository, or null when it never had one. */
  repository: string | null;
};

/** Workers' settings read at once while looking for which other Workers use a resource. */
const SETTINGS_READ_CONCURRENCY = 6;
/** Passes over an R2 bucket's objects before its deletion is reported as still emptying. */
const R2_EMPTYING_PASSES = 5;

/**
 * What deleting `project` removes. Its Workers: the ones CloudChef published it to (`workerNames`), or the one
 * Workers Builds builds it into, with the triggers that build it. Then every D1 database, KV namespace, R2 bucket,
 * queue, Vectorize index and Hyperdrive config those Workers bind that no other Worker in the account binds (or, for
 * a queue, sends to or reads from); one another Worker uses, or one of CloudChef's own, is kept. Other kinds of
 * resource a binding can name are kept too: CloudChef doesn't delete them.
 */
export async function planProjectDeletion(
  api: ProjectDeletionApi,
  project: Pick<
    Project,
    'repo' | 'importSource' | 'workersBuildsScriptTag' | 'deploysWith' | 'deployWorkerName' | 'siteUrl'
  >,
  workerNames: readonly string[],
): Promise<ProjectDeletionPlan> {
  const built = project.deploysWith === 'cloudchef' ? null : await findProjectWorker(api, project);
  const named =
    project.deploysWith === 'cloudchef'
      ? [...workerNames, ...(project.deployWorkerName ? [project.deployWorkerName] : [])]
      : [built?.name].filter((name) => name !== undefined);
  const workers: string[] = [];
  const bound = new Map<string, WorkerBinding>();
  for (const name of new Set(named)) {
    const bindings = isCloudChefResourceName(name) ? null : await api.workerBindings(name);
    if (bindings === null) {
      continue;
    }
    workers.push(name);
    for (const binding of bindings) {
      bound.set(bindingKey(binding), binding);
    }
  }
  const usedElsewhere = bound.size === 0 ? new Set<string>() : await bindingsOfOtherWorkers(api, workers);
  let queues: Promise<AccountQueue[]> | null = null;
  const listQueues = () => (queues ??= api.listQueues());
  const resources: DeletionResource[] = [];
  const kept: ProjectDeletionPlan['kept'] = [];
  for (const [key, binding] of bound) {
    const resource = await describe(api, binding, listQueues);
    if (resource === null) {
      continue;
    }
    if (binding.kind === 'other') {
      kept.push({ ...resource, reason: 'CloudChef doesn’t delete this kind of resource' });
    } else if (isCloudChefResourceName(resource.name)) {
      kept.push({ ...resource, reason: 'CloudChef uses it' });
    } else if (
      usedElsewhere.has(key) ||
      (binding.kind === 'queue' &&
        (await listQueues()).some(
          (queue) => queue.name === binding.name && queue.workers.some((worker) => !workers.includes(worker)),
        ))
    ) {
      kept.push({ ...resource, reason: 'another Worker uses it' });
    } else {
      resources.push(resource);
    }
  }
  const buildTriggers =
    built && workers.includes(built.name)
      ? (await api.listWorkersBuildTriggers(built.tag)).map((trigger) => trigger.id)
      : [];
  return {
    sites: project.siteUrl ? [project.siteUrl] : [],
    workers,
    buildTriggers,
    resources,
    kept,
    repository: project.repo,
  };
}

/**
 * Deletes what `plan` lists, in order: its builds triggers (so nothing builds it again), its Workers (so nothing
 * serves or writes any more), then their resources, then the repository, then every member's workspace of it. A step already done counts as done, so
 * deleting again after a failure picks up where it stopped. Answers what was deleted, and the step that failed with why, or null.
 */
export async function deleteProjectResources(
  api: ProjectDeletionApi,
  plan: ProjectDeletionPlan,
  deleteRepository: (repo: string) => Promise<void>,
  removeWorkspaces: () => Promise<void>,
): Promise<{ deleted: string[]; failed: { step: string; reason: string } | null }> {
  const steps: { label: string; run: () => Promise<void> }[] = [
    ...(plan.buildTriggers.length > 0
      ? [
          {
            label: `Automatic builds of ${plan.workers.join(', ')}`,
            run: async () => {
              for (const trigger of plan.buildTriggers) {
                await api.deleteWorkersBuildTrigger(trigger);
              }
            },
          },
        ]
      : []),
    ...plan.workers.map((name) => ({ label: `Worker ${name}`, run: () => api.deleteManagedWorker(name) })),
    ...plan.resources.map((resource) => ({ label: resourceLabel(resource), run: () => deleteResource(api, resource) })),
    ...(plan.repository ? [{ label: 'Code and its history', run: () => deleteRepository(plan.repository ?? '') }] : []),
    { label: 'Everyone’s workspaces of it', run: removeWorkspaces },
  ];
  const deleted: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      return { deleted, failed: { step: step.label, reason: error instanceof Error ? error.message : String(error) } };
    }
    deleted.push(step.label);
  }
  return { deleted, failed: null };
}

/** How a resource is named to people. */
function resourceLabel(resource: DeletionResource): string {
  const kind =
    resource.kind === 'database'
      ? 'Database'
      : resource.kind === 'storage'
        ? 'File storage'
        : resource.kind === 'keys'
          ? 'Key-value store'
          : resource.kind === 'queue'
            ? 'Queue'
            : resource.kind === 'vectors'
              ? 'Search index'
              : resource.kind === 'connection'
                ? 'Database connection'
                : 'Resource';
  return `${kind} ${resource.name}`;
}

async function deleteResource(api: ProjectDeletionApi, resource: DeletionResource): Promise<void> {
  if (resource.kind === 'database') {
    await api.deleteD1DatabaseById(resource.id);
  } else if (resource.kind === 'keys') {
    await api.deleteKvNamespaceById(resource.id);
  } else if (resource.kind === 'queue') {
    await api.deleteQueueById(resource.id);
  } else if (resource.kind === 'vectors') {
    await api.deleteVectorizeIndex(resource.id);
  } else if (resource.kind === 'connection') {
    await api.deleteHyperdriveConfig(resource.id);
  } else if (resource.kind === 'storage') {
    // A bucket is emptied a batch of objects at a time before it can go.
    for (let pass = 0; pass < R2_EMPTYING_PASSES; pass += 1) {
      if (await api.deleteR2Bucket(resource.id)) {
        return;
      }
    }
    throw new Error(`${resource.name} still has files being removed. Delete the project again in a few minutes.`);
  }
}

/** The resources every Worker of the account other than `workers` binds, by `bindingKey`. */
async function bindingsOfOtherWorkers(api: ProjectDeletionApi, workers: readonly string[]): Promise<Set<string>> {
  const others = (await api.listWorkerScripts()).filter((script) => !workers.includes(script.name));
  const used = new Set<string>();
  for (let start = 0; start < others.length; start += SETTINGS_READ_CONCURRENCY) {
    const batch = await Promise.all(
      others.slice(start, start + SETTINGS_READ_CONCURRENCY).map((script) => api.workerBindings(script.name)),
    );
    for (const bindings of batch) {
      for (const binding of bindings ?? []) {
        used.add(bindingKey(binding));
      }
    }
  }
  return used;
}

function bindingKey(binding: WorkerBinding): string {
  if (binding.kind === 'r2') {
    return `r2:${binding.bucket}`;
  }
  if (binding.kind === 'queue' || binding.kind === 'vectorize') {
    return `${binding.kind}:${binding.name}`;
  }
  if (binding.kind === 'other') {
    return `${binding.type}:${binding.name}`;
  }
  return `${binding.kind}:${binding.id}`;
}

/** The resource a binding names, or null when it no longer exists. */
async function describe(
  api: ProjectDeletionApi,
  binding: WorkerBinding,
  listQueues: () => Promise<AccountQueue[]>,
): Promise<DeletionResource | null> {
  if (binding.kind === 'd1') {
    const name = await api.d1DatabaseName(binding.id);
    return name === null ? null : { kind: 'database', id: binding.id, name };
  }
  if (binding.kind === 'kv') {
    const name = await api.kvNamespaceTitle(binding.id);
    return name === null ? null : { kind: 'keys', id: binding.id, name };
  }
  if (binding.kind === 'r2') {
    return { kind: 'storage', id: binding.bucket, name: binding.bucket };
  }
  if (binding.kind === 'queue') {
    const queue = (await listQueues()).find((listed) => listed.name === binding.name);
    return queue ? { kind: 'queue', id: queue.id, name: queue.name } : null;
  }
  if (binding.kind === 'vectorize') {
    return (await api.vectorizeIndexExists(binding.name))
      ? { kind: 'vectors', id: binding.name, name: binding.name }
      : null;
  }
  if (binding.kind === 'hyperdrive') {
    const name = await api.hyperdriveConfigName(binding.id);
    return name === null ? null : { kind: 'connection', id: binding.id, name };
  }
  return { kind: 'other', id: binding.name, name: `${binding.name} (${binding.type})` };
}
