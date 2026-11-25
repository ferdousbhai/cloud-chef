import { z } from 'zod';

/**
 * What may go to Cloudflare's API, with the account's authorization, while CloudChef deploys a project it deploys
 * itself. It must hold even when the project's own code sends the requests (the deploy runs the project's build
 * output and Wrangler config), so it allows what deploying one Worker takes and nothing that reaches CloudChef's own
 * Workers and resources in the account or reads stored data: reading the account's Workers settings for that one
 * Worker, and its D1 databases, KV namespaces and R2 buckets by name; writing that one Worker, with bindings that
 * never reach CloudChef's own (`deployBindingsCheck`); making the D1, KV and R2 resources its config asks for; and
 * running SQL on D1 databases that aren't CloudChef's. Nothing is ever deleted, and no other Worker is written.
 */

type DeployApiRequest = { method: string; pathname: string };

/**
 * How a request is sent on: with the account's token; as it came (asset uploads carry their own); with the token
 * once the Worker upload's bindings pass `deployBindingsCheck`, or once the D1 database it runs SQL on, or the
 * resource it makes, isn't CloudChef's; or not at all.
 */
type DeployApiDecision =
  'with_token' | 'as_sent' | 'check_bindings' | 'check_database' | 'check_new_resource' | 'refused';

const READ_METHODS = new Set(['GET', 'HEAD']);
const WRITE_METHODS = new Set(['PUT', 'POST', 'PATCH']);
const API_PREFIX = '/client/v4/';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A resource name as Cloudflare allows them for buckets and Workers. */
const NAME = '[a-z0-9][a-z0-9-]{0,62}';
const KV_ID = '[0-9a-f]{32}';

/** CloudChef's own Workers, databases, buckets and Workflows in the account all start so. */
export function isCloudChefResourceName(name: string): boolean {
  return name.toLowerCase().startsWith('cloudchef');
}

/** The decision for one request of a deploy of `workerName` in `accountId`, by its raw (still encoded) path. */
export function deployApiDecision(
  request: DeployApiRequest,
  context: { accountId: string; workerName: string },
): DeployApiDecision {
  const method = request.method.toUpperCase();
  if (!request.pathname.startsWith(API_PREFIX) || /%|\/\/|\/\.\.?(\/|$)/.test(request.pathname)) {
    return 'refused';
  }
  const path = request.pathname.slice(API_PREFIX.length - 1).replace(/\/$/, '');
  const account = `/accounts/${context.accountId}`;
  if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
    return 'refused';
  }
  // Wrangler reads who it is and the account it deploys to.
  if (READ_METHODS.has(method) && (path === '/user' || path === '/memberships' || path === account)) {
    return 'with_token';
  }
  if (!path.startsWith(`${account}/`)) {
    return 'refused';
  }
  const rest = path.slice(account.length);
  const self = `/workers/(scripts|services|workers)/${context.workerName}(/[^]*)?`;
  if (READ_METHODS.has(method)) {
    return new RegExp(
      `^(/workers/subdomain|${self}|/d1/database|/d1/database/${UUID}|/storage/kv/namespaces|` +
        `/storage/kv/namespaces/${KV_ID}|/r2/buckets|/r2/buckets/${NAME})$`,
    ).test(rest)
      ? 'with_token'
      : 'refused';
  }
  // Static assets go up with the upload session's own JWT, which Wrangler sends itself.
  if (method === 'POST' && rest === '/workers/assets/upload') {
    return 'as_sent';
  }
  // Custom domains and routes could claim any hostname of the account, a teammate's site's among them.
  if (/\/(domains|routes)(\/|$)/.test(rest)) {
    return 'refused';
  }
  // Cron triggers are a list of schedules, and nothing else.
  if (method === 'PUT' && rest === `/workers/scripts/${context.workerName}/schedules`) {
    return 'with_token';
  }
  if (new RegExp(`^${self}$`).test(rest)) {
    return 'check_bindings';
  }
  if (method === 'POST' && new RegExp(`^/d1/database/${UUID}/(query|raw)$`).test(rest)) {
    return 'check_database';
  }
  if (method === 'POST' && (rest === '/d1/database' || rest === '/storage/kv/namespaces' || rest === '/r2/buckets')) {
    return 'check_new_resource';
  }
  return 'refused';
}

/**
 * The binding types a project's Worker may have; anything else is refused: Secrets Store (CloudChef keeps keys
 * there), Hyperdrive (another project's database credentials), dispatch namespaces, unsafe bindings.
 */
const BINDING_TYPES = new Set([
  'plain_text',
  'secret_text',
  'json',
  'inherit',
  'kv_namespace',
  'r2_bucket',
  'd1',
  'durable_object_namespace',
  'service',
  'queue',
  'workflow',
  'analytics_engine',
  'ai',
  'assets',
  'browser',
  'images',
  'media',
  'version_metadata',
  'vectorize',
  'send_email',
  'ratelimit',
  'pipelines',
  'wasm_module',
  'text_blob',
  'data_blob',
]);

/** The D1 databases and KV namespaces a Worker upload binds by id, to look up before it goes on. */
export type BindingLookups = { databases: string[]; namespaces: string[] };

const NAMED_FIELDS = ['script_name', 'service', 'bucket_name', 'workflow_name', 'queue_name'] as const;

const bindingSchema = z.looseObject({
  type: z.string(),
  script_name: z.string().optional(),
  service: z.string().optional(),
  bucket_name: z.string().optional(),
  workflow_name: z.string().optional(),
  queue_name: z.string().optional(),
  namespace_id: z.string().optional(),
  id: z.string().optional(),
  database_id: z.string().optional(),
  class_name: z.string().optional(),
  dataset: z.string().optional(),
  index_name: z.string().optional(),
  pipeline: z.string().optional(),
});

const consumersSchema = z.array(z.looseObject({ service: z.string().optional() })).optional();
const transfersSchema = z.array(z.looseObject({ from_script: z.string().optional() })).optional();
const migrationSchema = z.looseObject({ transferred_classes: transfersSchema });

/** The parts of a Worker upload's `metadata` or `settings` that could reach beyond the Worker itself. */
export const workerSettingsSchema = z.looseObject({
  bindings: z.array(bindingSchema).optional(),
  tail_consumers: consumersSchema,
  streaming_tail_consumers: consumersSchema,
  migrations: z
    .union([migrationSchema.extend({ steps: z.array(migrationSchema).optional() }), z.array(migrationSchema)])
    .optional(),
});

/**
 * Whether the settings a Worker upload carries (its bindings, Durable Object migrations, tail consumers) stay clear
 * of CloudChef's own Workers and resources: a refusal to show, or the ids to look up.
 */
export function deployBindingsCheck(
  settings: z.infer<typeof workerSettingsSchema>,
  workerName: string,
): { refusal: string } | { lookups: BindingLookups } {
  const lookups: BindingLookups = { databases: [], namespaces: [] };
  const refuse = (what: string) => ({ refusal: `The project's Worker can't use ${what}.` });
  for (const binding of settings.bindings ?? []) {
    if (!BINDING_TYPES.has(binding.type)) {
      return refuse(`a binding of type ${binding.type}`);
    }
    if (NAMED_FIELDS.some((field) => isCloudChefResourceName(binding[field] ?? ''))) {
      return refuse('CloudChef’s own Workers or resources');
    }
    if (binding.type === 'durable_object_namespace' && binding.namespace_id !== undefined) {
      return refuse('a Durable Object namespace by its id');
    }
    if (binding.type === 'd1') {
      const id = binding.id ?? binding.database_id;
      if (id === undefined) {
        return refuse('a D1 database without its id');
      }
      lookups.databases.push(id);
    }
    if (binding.type === 'kv_namespace') {
      if (binding.namespace_id === undefined) {
        return refuse('a KV namespace without its id');
      }
      lookups.namespaces.push(binding.namespace_id);
    }
  }
  const consumers = [...(settings.tail_consumers ?? []), ...(settings.streaming_tail_consumers ?? [])];
  if (consumers.some((consumer) => isCloudChefResourceName(consumer.service ?? ''))) {
    return refuse('CloudChef’s own Workers');
  }
  const migrations = Array.isArray(settings.migrations)
    ? settings.migrations
    : settings.migrations
      ? [settings.migrations, ...(settings.migrations.steps ?? [])]
      : [];
  const transfers = migrations.flatMap((migration) => migration.transferred_classes ?? []);
  if (transfers.some((transfer) => transfer.from_script !== undefined && transfer.from_script !== workerName)) {
    return refuse('Durable Objects moved from another Worker');
  }
  return { lookups };
}

/** Bindings that are the Worker's own code and settings: they reach nothing else in the account. */
const OWN_BINDING_TYPES = new Set([
  'plain_text',
  'secret_text',
  'json',
  'inherit',
  'assets',
  'version_metadata',
  'wasm_module',
  'text_blob',
  'data_blob',
  'ratelimit',
]);

/**
 * What a binding uses in the account beyond the Worker itself, in words a person reads: a resource by its name or
 * id, or a product by its name (Workers AI, sending email), which is the same thing however its variable is called.
 * Null for a binding that uses nothing else: its own settings, and its own Durable Objects and Workflows.
 */
function bindingResource(binding: z.infer<typeof bindingSchema>, workerName: string): string | null {
  if (OWN_BINDING_TYPES.has(binding.type)) {
    return null;
  }
  const another = binding.script_name !== undefined && binding.script_name !== workerName;
  switch (binding.type) {
    case 'd1':
      return `the D1 database ${binding.id ?? binding.database_id ?? 'without an id'}`;
    case 'kv_namespace':
      return `the KV namespace ${binding.namespace_id ?? 'without an id'}`;
    case 'r2_bucket':
      return `the R2 bucket ${binding.bucket_name ?? 'without a name'}`;
    case 'service':
      return binding.service === workerName ? null : `the Worker ${binding.service ?? 'without a name'}`;
    case 'queue':
      return `the queue ${binding.queue_name ?? 'without a name'}`;
    case 'durable_object_namespace':
      return another ? `the Durable Object ${binding.class_name ?? ''} of the Worker ${binding.script_name}` : null;
    case 'workflow':
      return another ? `the Workflow ${binding.workflow_name ?? ''} of the Worker ${binding.script_name}` : null;
    case 'analytics_engine':
      return `the Analytics Engine dataset ${binding.dataset ?? 'without a name'}`;
    case 'vectorize':
      return `the Vectorize index ${binding.index_name ?? 'without a name'}`;
    case 'pipelines':
      return `the pipeline ${binding.pipeline ?? 'without a name'}`;
    case 'ai':
      return 'Workers AI';
    case 'browser':
      return 'Browser Rendering';
    case 'images':
      return 'Cloudflare Images';
    case 'media':
      return 'Cloudflare Media';
    case 'send_email':
      return 'sending email';
    default:
      return `a binding of type ${binding.type}`;
  }
}

/** Everything a Worker's settings use in the account beyond the Worker itself, tail Workers among them. */
function settingsResources(settings: z.infer<typeof workerSettingsSchema>, workerName: string): Set<string> {
  const resources = new Set<string>();
  for (const binding of settings.bindings ?? []) {
    const resource = bindingResource(binding, workerName);
    if (resource) {
      resources.add(resource);
    }
  }
  for (const consumer of [...(settings.tail_consumers ?? []), ...(settings.streaming_tail_consumers ?? [])]) {
    if (consumer.service && consumer.service !== workerName) {
      resources.add(`the tail Worker ${consumer.service}`);
    }
  }
  return resources;
}

/**
 * For a collaborator's publish: what the Worker being uploaded would use that the project's live Worker doesn't use
 * already (`live`, its settings as Cloudflare has them; none for a project never published). Empty when it adds
 * nothing.
 */
export function addedResources(
  upload: z.infer<typeof workerSettingsSchema>,
  live: z.infer<typeof workerSettingsSchema> | null,
  workerName: string,
): string[] {
  const has = live ? settingsResources(live, workerName) : new Set<string>();
  return [...settingsResources(upload, workerName)].filter((resource) => !has.has(resource));
}

/** The D1 databases a Worker's settings bind, by id: the ones a collaborator's publish may run SQL on. */
export function boundDatabases(settings: z.infer<typeof workerSettingsSchema> | null): Set<string> {
  return new Set(
    (settings?.bindings ?? []).flatMap((binding) => {
      const id = binding.type === 'd1' ? (binding.id ?? binding.database_id) : undefined;
      return id === undefined ? [] : [id];
    }),
  );
}

/** Said when a collaborator's publish would add something to the account. */
export function collaboratorRefusal(added: readonly string[]): string {
  return `This version adds ${added.join(', ')} to the project. Someone added to a project works with what it already has: its creator, or an admin of its space, publishes a version that adds something.`;
}
