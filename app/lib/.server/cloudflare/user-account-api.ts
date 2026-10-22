import { z } from 'zod';
import {
  deploymentAssetExtension,
  deploymentAssetHash,
  WORKER_MAIN_MODULE,
  type DeploymentArtifactFile,
} from './deployment-artifact';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_ASSETS_RUN_WORKER_FIRST,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
  DEPLOYMENT_PREVIEW_URLS_ENABLED,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
} from './deployment-runtime-policy';
import {
  PROJECT_WORKSPACE_CONTAINER_DIMENSIONS,
  PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
  PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
} from './project-workspace-container-policy';
import { CLOUDCHEF_CONTROL_PLANE_ENDPOINT, USER_WORKSPACE_RUNTIME_GC_CRON } from './user-workspace-runtime-policy';
import { bytesToBase64, sha256Hex } from '~/lib/hex-digest';
import { PayloadTooLargeError, readBodyBytesWithLimit } from '~/lib/bounded-body';
import { isRecord } from 'cloudchef-agent/utils/isRecord';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_API_TIMEOUT_MS = 30_000;
const MAX_CLOUDFLARE_RESPONSE_BYTES = 1024 * 1024;
/** Page size for whole-account listings; providers are free to return fewer. */
const ACCOUNT_LIST_PAGE_SIZE = 1000;
/** Refuse rather than walk forever if a listing never signals its end. */
const MAX_ACCOUNT_LIST_PAGES = 50;
const ACCOUNT_LIST_TOO_LONG = 'Cloudflare returned more pages than one account listing may read.';
const MAX_ASSET_UPLOAD_JWT_BYTES = 16 * 1024;
const ASSET_HASH_PATTERN = /^[a-f0-9]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const R2_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const R2_CLEANUP_BATCH_SIZE = 100;
const R2_CLEANUP_LIFECYCLE_ID = 'cloudchef-project-deletion';
const R2_CLEANUP_MAX_AGE_SECONDS = 24 * 60 * 60;
const CONTAINER_ROLLOUT_DEADLINE_MS = 20 * 60_000;
const CONTAINER_ROLLOUT_POLL_INTERVAL_MS = 5_000;
/** How much of Cloudflare's own wording one entitlement verdict carries into an operator log. */
const PROVIDER_TEXT_LIMIT = 400;

/**
 * Text shapes that must never reach an operator log, whatever Cloudflare put in its refusal.
 * Every one is global, because these are applied with `replaceAll`.
 */
const CREDENTIAL_REDACTION_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+\S+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g,
  /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\b[0-9a-f]{16,}\b/gi,
  /[?&](?:key|token|secret|password|api_key|access_token)=[^\s&#]*/gi,
];

type DurableObjectNamespaceReadback = {
  id?: string;
  class?: string;
  script?: string;
  use_sqlite?: boolean;
};

type ContainerApplicationReadback = {
  id?: string;
  name?: string;
  durable_objects?: { namespace_id?: string };
};

type ContainerApplicationRolloutReadback = {
  id?: string;
  created_at?: string;
  status?: string;
  target_configuration?: unknown;
};

/**
 * Whether the connected account may run Cloudflare Containers. `undetermined` is deliberately not a
 * verdict: an unreachable or unreadable answer must not be spent as eligibility or as refusal.
 */
type WorkspaceContainersEntitlement =
  | { status: 'entitled' }
  | { status: 'plan_required'; message: string; upgradeUrl: string | null }
  | { status: 'undetermined'; reason: string };

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  result_info?: CloudflareResultInfo;
  errors?: Array<{ code?: number; message?: string }>;
};

/** The pagination counters Cloudflare returns alongside a listing, none of them guaranteed. */
type CloudflareResultInfo = {
  total_count?: number;
  total_pages?: number;
};

type EnvelopeResult<T> = { result: T; resultInfo: CloudflareResultInfo | undefined };

type WorkspaceContainerConfiguration = {
  image: string;
  instance_type: string;
  observability: { logs: { enabled: boolean } };
  wrangler_ssh: { enabled: boolean };
};

type WorkerUploadMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: unknown[];
  assets?: { jwt: string; config?: { run_worker_first: readonly string[] } };
  exports?: { AppAgent: typeof APP_AGENT_DECLARATIVE_EXPORT };
  observability: typeof DEPLOYMENT_OBSERVABILITY;
  annotations: { 'workers/message': string; 'workers/tag': string };
};

/** One immutable Worker version's bytes and bindings, whether it is promoted or only previewed. */
export type ManagedWorkerVersionArgs = {
  workerName: string;
  projectType: 'web_app' | 'worker';
  sourceSha256: string;
  mainModule: string;
  modules: readonly DeploymentArtifactFile[];
  assets: readonly DeploymentArtifactFile[];
  /** Route pages and API through the Worker first, serving files through an `ASSETS` binding. */
  workerFirstAssets: boolean;
  workersAi: boolean;
  appAgent: boolean;
  d1DatabaseId?: string;
  agentSecurityD1DatabaseId?: string;
  r2BucketName?: string;
  kvNamespaceId?: string;
};

/** A provider key stored on an AI Gateway (BYOK), as Cloudflare describes it: never the key itself. */
export type AiGatewayProviderKey = {
  id: string;
  providerSlug: string;
  alias: string;
  isDefault: boolean;
  /** Cloudflare's masked preview of the key, such as `sk-a...wxyz`. */
  secretPreview: string | null;
  modifiedAt: string | null;
};

/** A Secrets Store secret AI Gateway may use: its name and where it is, never its value. */
type SecretsStoreSecret = { id: string; name: string; storeId: string };

/** The Secrets Store scope that lets AI Gateway read a secret as a provider key. */
const AI_GATEWAY_SECRET_SCOPE = 'ai_gateway';

const aiGatewayProviderKeySchema = z.looseObject({
  id: z.string().min(1).max(128),
  provider_slug: z.string().min(1).max(128),
  alias: z.string().max(128).catch(''),
  default_config: z.boolean().catch(false),
  secret_preview: z.string().max(128).nullable().optional().catch(null),
  modified_at: z.string().max(64).nullable().optional().catch(null),
});

const secretsStoreSecretSchema = z.looseObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
  scopes: z.array(z.string()).catch([]),
});

/** A Durable Object namespace as the account listing names it: the Worker and the class it belongs to. */
const durableObjectNamespaceSchema = z.looseObject({ script: z.string(), class: z.string() });
/** One rollout of a container application, as Cloudflare reports it. */
const containerApplicationRolloutSchema = z.looseObject({
  id: z.string(),
  created_at: z.string(),
  status: z.string(),
  target_configuration: z.record(z.string(), z.json()),
});

/** A migration receipt's applied SQL; a receipt written before receipts kept it has none. */
const appliedMigrationSqlSchema = z.looseObject({ sql: z.string() });
/** A migration receipt's name and digest; a receipt from before receipts kept digests has none. */
const d1MigrationReceiptSchema = z.looseObject({ name: z.string(), digest: z.string().nullable() });
/** Every statement of a D1 query, each of which must have succeeded. */
const d1QueryResultsSchema = z
  .array(z.looseObject({ success: z.literal(true), results: z.array(z.unknown()).optional() }))
  .min(1);
type D1QueryResult = z.infer<typeof d1QueryResultsSchema>[number];
/** The D1 databases the account lists under a name. */
const d1DatabasesSchema = z.array(z.looseObject({ name: z.string().min(1), uuid: z.string().min(1).max(256) }));
/** A KV namespace as the account lists it; one listed without an id or title is not CloudChef's to use. */
const kvNamespaceSchema = z.looseObject({ id: z.string(), title: z.string() });
/** A Worker's cron triggers, as Cloudflare reports them after a change and on a read. */
const workerSchedulesSchema = z.looseObject({ schedules: z.array(z.looseObject({ cron: z.string().min(1) })) });
/** A Worker's deployments, each with the versions it routes traffic to. */
const workerDeploymentsSchema = z.looseObject({
  deployments: z.array(
    z.looseObject({
      id: z.string().min(1),
      created_on: z.string().min(1),
      versions: z.array(z.looseObject({ percentage: z.number(), version_id: z.string().min(1) })),
    }),
  ),
});
type WorkerDeploymentRow = z.infer<typeof workerDeploymentsSchema>['deployments'][number];
/** The account's container applications, each named. */
const containerApplicationsSchema = z.array(z.looseObject({ name: z.string().min(1) }));
/** A container application CloudChef found by name: its id and the Durable Object namespace it serves. */
const containerApplicationSchema = z.looseObject({
  id: z.string().min(1),
  durable_objects: z.looseObject({ namespace_id: z.string().min(1) }),
});

/** An AI Gateway's settings as Cloudflare returns them, each kept so an update can write it back. */
const aiGatewaySettingsSchema = z.record(z.string(), z.json());

/** What Cloudflare sets on a gateway itself, which an update must not send. */
const READ_ONLY_AI_GATEWAY_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'created_at',
  'modified_at',
  'is_default',
  'internal',
  'wholesale',
]);

/**
 * The settings a gateway update must carry, as Cloudflare's own defaults. It reports "no rate limit"
 * as null but accepts only a number, which is 0 for the same thing.
 */
const REQUIRED_AI_GATEWAY_SETTINGS = {
  cache_invalidate_on_update: false,
  cache_ttl: 0,
  collect_logs: true,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  rate_limiting_technique: 'fixed',
} as const;

/** Every setting of a gateway an update may write, as it is now; unset (null) ones are left to the defaults. */
function writableGatewaySettings(gateway: z.infer<typeof aiGatewaySettingsSchema>) {
  const kept = Object.fromEntries(
    Object.entries(gateway).filter(([field, value]) => value !== null && !READ_ONLY_AI_GATEWAY_FIELDS.has(field)),
  );
  return { ...REQUIRED_AI_GATEWAY_SETTINGS, ...kept };
}

function aiGatewayProviderKey(value: z.infer<typeof aiGatewayProviderKeySchema>): AiGatewayProviderKey {
  return {
    id: value.id,
    providerSlug: value.provider_slug,
    alias: value.alias,
    isDefault: value.default_config,
    secretPreview: value.secret_preview ?? null,
    modifiedAt: value.modified_at ?? null,
  };
}

export class UserCloudflareAccountApi {
  constructor(
    private readonly accountId: string,
    private accessToken: string,
    private readonly refreshAccessToken?: () => Promise<string>,
  ) {
    if (!accountId || !accessToken) {
      throw new Error('Cloudflare account credentials are required.');
    }
  }

  /** The D1 database with this name, created when the account has none. */
  async ensureD1Database(resourceName: string): Promise<{ id: string; name: string }> {
    requireCloudflareResourceName(resourceName);
    return findOrCreate(
      async () => {
        const id = await this.findD1DatabaseId(resourceName);
        return id ? { id, name: resourceName } : null;
      },
      async () => {
        const result = await this.call<{ uuid?: string; name?: string }>('/d1/database', {
          method: 'POST',
          body: JSON.stringify({ name: resourceName }),
        });
        if (!result.uuid || result.name !== resourceName) {
          throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
        }
        return { id: result.uuid, name: result.name };
      },
    );
  }

  private async executeD1(databaseId: string, sql: string, params: unknown[] = []): Promise<D1QueryResult[]> {
    if (!sql.trim()) {
      throw new CloudflareAccountApiError('Invalid D1 query.');
    }
    return this.executeD1Payload(databaseId, { sql, params });
  }

  private async executeD1Batch(
    databaseId: string,
    batch: readonly { sql: string; params?: unknown[] }[],
  ): Promise<D1QueryResult[]> {
    if (batch.length === 0 || batch.some((statement) => !statement.sql.trim())) {
      throw new CloudflareAccountApiError('Invalid D1 query batch.');
    }
    return this.executeD1Payload(databaseId, {
      batch: batch.map((statement) => ({ sql: statement.sql, params: statement.params ?? [] })),
    });
  }

  private async executeD1Payload(databaseId: string, payload: Record<string, unknown>): Promise<D1QueryResult[]> {
    if (!/^[0-9a-f-]{32,64}$/i.test(databaseId)) {
      throw new CloudflareAccountApiError('Invalid D1 query.');
    }
    const result = d1QueryResultsSchema.safeParse(
      await this.call<unknown>(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
    if (!result.success) {
      throw new CloudflareAccountApiError('Cloudflare returned an unsuccessful D1 query result.');
    }
    return result.data;
  }

  async applyD1Migrations(databaseId: string, migrations: readonly { name: string; sql: string }[]): Promise<void> {
    await this.executeD1(
      databaseId,
      `CREATE TABLE IF NOT EXISTS cloudchef_runtime_migrations (
         name TEXT PRIMARY KEY NOT NULL,
         applied_at INTEGER NOT NULL,
         digest TEXT,
         sql TEXT
       )`,
    );
    await this.ensureD1MigrationSqlColumn(databaseId);
    // One receipt read for the whole set rather than one per migration. Applying migration N
    // cannot change migration N+1's receipt, so the extra round trips bought nothing — and this
    // path runs on every runtime upgrade for every existing account, where the answer is always
    // "all of them are already applied" and the reads were the entire cost.
    const receipts = await this.executeD1(databaseId, 'SELECT name, digest FROM cloudchef_runtime_migrations');
    // Every receipt is checked before any migration runs, so a set this database refuses changes
    // nothing in it rather than applying the migrations ahead of the one it refuses.
    const pending: { name: string; sql: string; digest: string }[] = [];
    for (const migration of migrations) {
      if (!/^\d{4}_.+\.sql$/.test(migration.name) || !migration.sql.trim()) {
        throw new CloudflareAccountApiError('Invalid user-runtime D1 migration.');
      }
      const digest = await sha256Hex(migration.sql);
      const receipt = d1MigrationReceipt(receipts, migration.name);
      if (receipt?.digest === digest) {
        continue;
      }
      if (receipt) {
        throw new D1MigrationChangedError(migration.name, await this.appliedD1MigrationSql(databaseId, migration.name));
      }
      pending.push({ ...migration, digest });
    }
    for (const { digest, ...migration } of pending) {
      try {
        await this.executeD1Batch(databaseId, [
          { sql: migration.sql },
          {
            sql: 'INSERT INTO cloudchef_runtime_migrations (name, applied_at, digest, sql) VALUES (?, ?, ?, ?)',
            params: [migration.name, Date.now(), digest, migration.sql],
          },
        ]);
      } catch (error) {
        // A lost acknowledgement after D1 commits must not replay a
        // non-idempotent migration. Resolve the ambiguity by reading its
        // transactional marker before surfacing the original failure.
        const committed = await this.executeD1(
          databaseId,
          'SELECT name, digest FROM cloudchef_runtime_migrations WHERE name = ?',
          [migration.name],
        ).catch((readError) => {
          console.warn('Unable to verify D1 migration commit', readError);
          return [];
        });
        const committedReceipt = d1MigrationReceipt(committed, migration.name);
        if (committedReceipt?.digest === digest) {
          continue;
        }
        if (committedReceipt) {
          throw new D1MigrationChangedError(
            migration.name,
            await this.appliedD1MigrationSql(databaseId, migration.name),
          );
        }
        throw error;
      }
    }
  }

  /**
   * Adds the `sql` column a receipt table created before receipts kept their SQL lacks; the receipts
   * written before it keep none, which is only ever reported.
   */
  private async ensureD1MigrationSqlColumn(databaseId: string): Promise<void> {
    const columns = await this.executeD1(databaseId, 'PRAGMA table_info(cloudchef_runtime_migrations)');
    if (!d1ResultsContain(columns, (row) => row.name === 'sql')) {
      await this.executeD1(databaseId, 'ALTER TABLE cloudchef_runtime_migrations ADD COLUMN sql TEXT');
    }
  }

  /**
   * The SQL a database recorded applying under a migration's name, read only to tell the model what to
   * restore. A receipt from before the database recorded it, or a failed read, answers null.
   */
  private async appliedD1MigrationSql(databaseId: string, name: string): Promise<string | null> {
    const results = await this.executeD1(databaseId, 'SELECT sql FROM cloudchef_runtime_migrations WHERE name = ?', [
      name,
    ]).catch(() => []);
    for (const result of results) {
      for (const row of result.results ?? []) {
        const receipt = appliedMigrationSqlSchema.safeParse(row);
        if (receipt.success) {
          return receipt.data.sql;
        }
      }
    }
    return null;
  }

  private async createR2Bucket(resourceName: string): Promise<{ id: string; name: string }> {
    requireR2BucketName(resourceName);
    const result = await this.call<{ name?: string }>('/r2/buckets', {
      method: 'POST',
      body: JSON.stringify({ name: resourceName }),
    });
    if (result.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 resource.');
    }
    return { id: result.name, name: result.name };
  }

  private async readR2Bucket(resourceName: string): Promise<{ id: string; name: string } | null> {
    const existing = await this.callOptional<{ name?: string }>(`/r2/buckets/${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    if (existing !== null && existing.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 resource.');
    }
    if (existing) {
      return { id: resourceName, name: resourceName };
    }
    return null;
  }

  /** The R2 bucket with this name, created when the account has none. */
  async ensureR2Bucket(resourceName: string): Promise<{ id: string; name: string }> {
    requireR2BucketName(resourceName);
    return findOrCreate(
      () => this.readR2Bucket(resourceName),
      () => this.createR2Bucket(resourceName),
    );
  }

  /** The KV namespace with this title, created when the account has none. */
  async ensureKvNamespace(resourceName: string): Promise<{ id: string; name: string }> {
    return findOrCreate(
      () => this.findKvNamespace(resourceName),
      async () => {
        const created = await this.call<{ id?: string; title?: string }>('/storage/kv/namespaces', {
          method: 'POST',
          body: JSON.stringify({ title: resourceName }),
        });
        if (!created.id || !/^[a-f0-9]{32}$/.test(created.id) || created.title !== resourceName) {
          throw new CloudflareAccountApiError('Cloudflare returned an invalid KV namespace.');
        }
        return { id: created.id, name: resourceName };
      },
    );
  }

  /** Resolve one namespace by name out of the account listing, which is the only KV lookup there is. */
  private async findKvNamespace(resourceName: string): Promise<{ id: string; name: string } | null> {
    requireCloudflareResourceName(resourceName);
    const matches = (await this.listKvNamespaces()).filter((namespace) => namespace.name === resourceName);
    if (matches.length > 1) {
      throw new CloudflareAccountApiError('Cloudflare returned ambiguous KV namespaces.');
    }
    const match = matches[0];
    if (!match) {
      return null;
    }
    if (!/^[a-f0-9]{32}$/.test(match.id)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid KV namespace.');
    }
    return { id: match.id, name: resourceName };
  }

  /**
   * The Durable Object classes Cloudflare holds a namespace for under the Worker: classes that came into
   * being through one of its deployments and were never deleted, whatever its active version exports.
   */
  async managedWorkerDurableObjectClasses(workerName: string): Promise<string[]> {
    requireWorkerName(workerName);
    const namespaces = await this.listAllPages(
      '/workers/durable_objects/namespaces',
      'Cloudflare returned invalid Durable Object namespaces.',
    );
    return namespaces.flatMap((value) => {
      const namespace = durableObjectNamespaceSchema.safeParse(value);
      return namespace.success && namespace.data.script === workerName ? [namespace.data.class] : [];
    });
  }

  /** Remove a CloudChef-managed Worker and its script-owned Durable Objects. */
  async deleteManagedWorker(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    await this.deleteOptional(`/workers/scripts/${encodeURIComponent(workerName)}?force=true`);
  }

  /**
   * Remove one person's workspace: its container application, then its Worker (with the Durable
   * Objects that hold their chats and project files), then its database. Each step is skipped when
   * already gone, so a retry after a partial failure finishes the job.
   */
  async deleteWorkspaceRuntime(names: { workerName: string; databaseName: string }): Promise<void> {
    const applications = await this.callContainer<unknown>('/applications', { method: 'GET' });
    const application = existingContainerApplication(applications, names.workerName);
    if (application) {
      await this.deleteOptional(`/containers/applications/${encodeURIComponent(application.id)}`);
    }
    await this.deleteManagedWorker(names.workerName);
    await this.deleteD1Database(names.databaseName);
  }

  /** The id Cloudflare holds for a database name, or null when the account has no such database. */
  private async findD1DatabaseId(resourceName: string): Promise<string | null> {
    requireCloudflareResourceName(resourceName);
    const databases = d1DatabasesSchema.safeParse(
      await this.call<unknown>(`/d1/database?name=${encodeURIComponent(resourceName)}`, { method: 'GET' }),
    );
    if (!databases.success) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource list.');
    }
    const matches = databases.data.filter((database) => database.name === resourceName);
    if (matches.length > 1) {
      throw new CloudflareAccountApiError('Cloudflare returned an ambiguous D1 resource list.');
    }
    return matches[0]?.uuid ?? null;
  }

  /**
   * Delete by an id the caller already holds, from provisioning or from an account listing.
   * Deleting by name has to re-resolve the id first, and only works while the name is still
   * derivable.
   */
  async deleteD1DatabaseById(databaseId: string): Promise<void> {
    requireProviderResourceId(databaseId);
    await this.deleteOptional(`/d1/database/${encodeURIComponent(databaseId)}`);
  }

  async deleteD1Database(resourceName: string): Promise<void> {
    const databaseId = await this.findD1DatabaseId(resourceName);
    if (databaseId) {
      await this.deleteD1DatabaseById(databaseId);
    }
  }

  /** Delete by an id the caller already holds, from provisioning or from an account listing. */
  async deleteKvNamespaceById(namespaceId: string): Promise<void> {
    requireProviderResourceId(namespaceId);
    await this.deleteOptional(`/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`);
  }

  async deleteKvNamespace(resourceName: string): Promise<void> {
    const namespace = await this.findKvNamespace(resourceName);
    if (namespace) {
      await this.deleteKvNamespaceById(namespace.id);
    }
  }

  /** Empty one bounded object batch, then delete the bucket once it is empty. */
  async deleteR2Bucket(resourceName: string): Promise<boolean> {
    requireR2BucketName(resourceName);
    const bucketPath = `/r2/buckets/${encodeURIComponent(resourceName)}`;
    const bucket = await this.callOptional<{ name?: string }>(bucketPath, { method: 'GET' });
    if (bucket === null) {
      return true;
    }
    if (bucket.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 resource.');
    }

    // A deleted project cannot retain user-configured object locks that would
    // otherwise prevent its bucket from being emptied.
    await this.callOptional<unknown>(`${bucketPath}/lock`, {
      method: 'PUT',
      body: JSON.stringify({ rules: [] }),
    });
    // Lifecycle deletion covers multipart uploads and object keys that cannot
    // safely be represented in a normalized URL path (notably `.` and `..`).
    await this.callOptional<unknown>(`${bucketPath}/lifecycle`, {
      method: 'PUT',
      body: JSON.stringify({
        rules: [
          {
            id: R2_CLEANUP_LIFECYCLE_ID,
            enabled: true,
            conditions: { prefix: '' },
            deleteObjectsTransition: {
              condition: { type: 'Age', maxAge: R2_CLEANUP_MAX_AGE_SECONDS },
            },
            abortMultipartUploadsTransition: {
              condition: { type: 'Age', maxAge: R2_CLEANUP_MAX_AGE_SECONDS },
            },
          },
        ],
      }),
    });
    const objectKeys = await this.listR2ObjectKeys(resourceName);
    if (objectKeys.length > 0) {
      await Promise.all(
        objectKeys
          .filter(isR2ObjectKeySafeForPathDeletion)
          .map((key) => this.deleteOptional(`${bucketPath}/objects/${encodeR2ObjectKey(key)}`)),
      );
      return false;
    }
    await this.deleteOptional(bucketPath);
    return true;
  }

  /** List every KV namespace in the connected account. Namespaces carry no creation time. */
  private async listKvNamespaces(): Promise<{ id: string; name: string }[]> {
    const namespaces = await this.listAllPages('/storage/kv/namespaces', 'Cloudflare returned invalid KV namespaces.');
    return namespaces.flatMap((value) => {
      const namespace = kvNamespaceSchema.safeParse(value);
      return namespace.success ? [{ id: namespace.data.id, name: namespace.data.title }] : [];
    });
  }

  /**
   * Read every page of a page-numbered account listing.
   *
   * Cloudflare is inconsistent about `result_info` - D1 reports `total_count` without
   * `total_pages`, others report both - so whichever total it offers decides, and a full page is
   * the fallback signal when it offers neither.
   */
  private async listAllPages(
    path: string,
    invalidMessage: string,
    pageSize: number = ACCOUNT_LIST_PAGE_SIZE,
  ): Promise<unknown[]> {
    const listed: unknown[] = [];
    for (let page = 1; page <= MAX_ACCOUNT_LIST_PAGES; page += 1) {
      const { result, resultInfo } = await this.callPage<unknown>(`${path}?page=${page}&per_page=${pageSize}`);
      if (!Array.isArray(result)) {
        throw new CloudflareAccountApiError(invalidMessage);
      }
      listed.push(...result);
      const more =
        typeof resultInfo?.total_pages === 'number'
          ? page < resultInfo.total_pages
          : typeof resultInfo?.total_count === 'number'
            ? listed.length < resultInfo.total_count
            : result.length >= pageSize;
      // An empty page cannot be followed by anything this walk could use.
      if (!more || result.length === 0) {
        return listed;
      }
    }
    throw new CloudflareAccountApiError(ACCOUNT_LIST_TOO_LONG);
  }

  /**
   * Upload an immutable version, then promote exactly that version, and return it. A preview is
   * published the same way, to the project's preview Worker.
   */
  async deployManagedWorker(args: ManagedWorkerVersionArgs): Promise<{ workerVersionId: string }> {
    const form = await this.managedWorkerUploadForm(args);
    // Cloudflare rejects a version upload for a Worker that has never been deployed, and applies
    // Durable Object class lifecycle only through a deployment, so both cases publish directly.
    if (args.appAgent || !(await this.hasWorkerDeployment(args.workerName))) {
      return { workerVersionId: await this.uploadWorkerDirectly(args.workerName, form) };
    }
    const workerVersionId = await this.uploadWorkerVersion(args.workerName, form);
    await this.promoteWorkerVersion(args.workerName, workerVersionId, args.sourceSha256);
    return { workerVersionId };
  }

  private async managedWorkerUploadForm(args: ManagedWorkerVersionArgs): Promise<FormData> {
    requireWorkerName(args.workerName);
    if (
      args.mainModule !== WORKER_MAIN_MODULE ||
      !/^[a-f0-9]{64}$/.test(args.sourceSha256) ||
      args.modules.filter((module) => module.path === WORKER_MAIN_MODULE).length !== 1 ||
      (args.kvNamespaceId !== undefined && !/^[a-f0-9]{32}$/.test(args.kvNamespaceId)) ||
      (args.projectType === 'worker' && (args.assets.length !== 0 || args.workerFirstAssets))
    ) {
      throw new CloudflareAccountApiError('Managed Worker deployment artifact is invalid.');
    }

    const assetJwt =
      args.projectType === 'web_app' ? await this.uploadStaticAssets(args.workerName, args.assets) : undefined;
    const bindings: Array<Record<string, unknown>> = [
      ...(args.workerFirstAssets ? [{ type: 'assets', name: 'ASSETS' }] : []),
      ...(args.workersAi ? [{ type: 'ai', name: 'AI' }] : []),
      ...(args.d1DatabaseId ? [{ type: 'd1', name: 'DB', id: args.d1DatabaseId }] : []),
      ...(args.agentSecurityD1DatabaseId
        ? [{ type: 'd1', name: 'AGENT_SECURITY_DB', id: args.agentSecurityD1DatabaseId }]
        : []),
      ...(args.r2BucketName ? [{ type: 'r2_bucket', name: 'APP_STORAGE', bucket_name: args.r2BucketName }] : []),
      ...(args.kvNamespaceId ? [{ type: 'kv_namespace', name: 'APP_CACHE', namespace_id: args.kvNamespaceId }] : []),
      ...(args.appAgent ? [{ type: 'durable_object_namespace', name: 'AppAgent', class_name: 'AppAgent' }] : []),
    ];
    const metadata: WorkerUploadMetadata = {
      main_module: WORKER_MAIN_MODULE,
      compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
      compatibility_flags: [...DEPLOYMENT_COMPATIBILITY_FLAGS],
      bindings,
      observability: DEPLOYMENT_OBSERVABILITY,
      annotations: {
        'workers/message': `CloudChef approved revision ${args.sourceSha256.slice(0, 12)}`,
        'workers/tag': args.sourceSha256,
      },
    };
    if (assetJwt) {
      metadata.assets = args.workerFirstAssets
        ? { jwt: assetJwt, config: { run_worker_first: DEPLOYMENT_ASSETS_RUN_WORKER_FIRST } }
        : { jwt: assetJwt };
    }
    if (args.appAgent) {
      metadata.exports = { AppAgent: APP_AGENT_DECLARATIVE_EXPORT };
    }
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    for (const module of args.modules) {
      form.set(
        module.path,
        new Blob([new Uint8Array(module.bytes).buffer], { type: workerModuleContentType(module.path) }),
        module.path,
      );
    }
    return form;
  }

  private async uploadWorkerVersion(workerName: string, form: FormData): Promise<string> {
    const version = await parseCloudflareEnvelope<{ id?: string }>(
      await this.callRaw(`/workers/scripts/${encodeURIComponent(workerName)}/versions`, {
        method: 'POST',
        body: form,
      }),
    );
    if (!version.id || !UUID_PATTERN.test(version.id)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Worker version identity.');
    }
    return version.id;
  }

  private async hasWorkerDeployment(workerName: string): Promise<boolean> {
    const listed = await this.callOptional<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/deployments`, {
      method: 'GET',
    });
    return listed !== null && requireWorkerDeployments(listed).length > 0;
  }

  /** Replace every trigger with the one server-owned AppAgent cleanup schedule, or none. */
  async configureManagedWorkerSchedule(workerName: string, appAgent: boolean): Promise<void> {
    await this.replaceWorkerSchedules(workerName, appAgent ? [DEPLOYMENT_SECURITY_CLEANUP_CRON] : []);
  }

  /** Replace every trigger with exactly `expected`, as Cloudflare answers the change and then reads it back. */
  private async replaceWorkerSchedules(workerName: string, expected: readonly string[]): Promise<void> {
    requireWorkerName(workerName);
    const path = `/workers/scripts/${encodeURIComponent(workerName)}/schedules`;
    requireExactSchedules(
      await this.call<unknown>(path, { method: 'PUT', body: JSON.stringify(expected.map((cron) => ({ cron }))) }),
      expected,
    );
    requireExactSchedules(await this.call<unknown>(path, { method: 'GET' }), expected);
  }

  private async uploadStaticAssets(workerName: string, assets: readonly DeploymentArtifactFile[]): Promise<string> {
    try {
      return await this.uploadStaticAssetsOnce(workerName, assets);
    } catch (error) {
      if (!(error instanceof AssetUploadSessionExpiredError)) {
        throw error;
      }
      return this.uploadStaticAssetsOnce(workerName, assets);
    }
  }

  private async uploadStaticAssetsOnce(workerName: string, assets: readonly DeploymentArtifactFile[]): Promise<string> {
    const byHash = new Map<string, DeploymentArtifactFile>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const asset of assets) {
      const hash = await deploymentAssetHash(asset);
      const existing = byHash.get(hash);
      if (
        !ASSET_HASH_PATTERN.test(hash) ||
        (existing !== undefined &&
          (deploymentAssetExtension(existing.path) !== deploymentAssetExtension(asset.path) ||
            !equalBytes(existing.bytes, asset.bytes)))
      ) {
        throw new CloudflareAccountApiError('Managed Worker assets contain an invalid content hash collision.');
      }
      if (!existing) {
        byHash.set(hash, asset);
      }
      manifest[`/${asset.path}`] = { hash, size: asset.size };
    }
    const session = await this.call<{ jwt?: string; buckets?: unknown }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/assets-upload-session`,
      { method: 'POST', body: JSON.stringify({ manifest }) },
    );
    let completionJwt = requireAssetUploadJwt(session.jwt);
    if (!Array.isArray(session.buckets) || session.buckets.length > byHash.size) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid asset upload buckets.');
    }
    // Cloudflare advertises the per-file upload protocol through a claim in the session
    // identity; wrangler treats it as a server-controlled rollout switch with the batched
    // multipart protocol as the other side. Deployments observed the claim disappear in
    // production on 2026-08-19 after working on 2026-08-12, so both sides are implemented
    // and the claim decides, exactly as wrangler does.
    const singleAssetUploads = session.buckets.length > 0 && hasSingleAssetUploadProtocol(completionJwt);
    const uploadBuckets = singleAssetUploads
      ? session.buckets.flatMap((bucket) => (Array.isArray(bucket) ? bucket.map((hash) => [hash]) : [bucket]))
      : session.buckets;
    const requested = new Set<string>();
    let receivedCompletionJwt = session.buckets.length === 0;
    for (const [bucketIndex, rawBucket] of uploadBuckets.entries()) {
      if (!Array.isArray(rawBucket) || rawBucket.length === 0 || rawBucket.length > byHash.size) {
        throw new CloudflareAccountApiError('Cloudflare returned invalid asset upload buckets.');
      }
      const bucketAssets: Array<{ hash: string; asset: DeploymentArtifactFile }> = [];
      for (const rawHash of rawBucket) {
        if (typeof rawHash !== 'string' || !ASSET_HASH_PATTERN.test(rawHash) || requested.has(rawHash)) {
          throw new CloudflareAccountApiError('Cloudflare returned invalid asset upload buckets.');
        }
        const asset = byHash.get(rawHash);
        if (!asset) {
          throw new CloudflareAccountApiError('Cloudflare requested an unknown managed Worker asset.');
        }
        requested.add(rawHash);
        bucketAssets.push({ hash: rawHash, asset });
      }
      let response: Response;
      if (singleAssetUploads) {
        const single = bucketAssets[0];
        if (bucketAssets.length !== 1 || !single) {
          throw new CloudflareAccountApiError('Cloudflare returned invalid single-file asset upload buckets.');
        }
        response = await this.executeRaw(
          `/workers/assets/upload/${encodeURIComponent(single.hash)}`,
          {
            method: 'POST',
            headers: { 'content-type': staticAssetContentType(single.asset.path) },
            body: new Uint8Array(single.asset.bytes).buffer,
          },
          completionJwt,
        );
      } else {
        const payload = new FormData();
        for (const { hash, asset } of bucketAssets) {
          // The batched protocol carries file bytes base64-encoded in multipart fields keyed
          // and named by content hash; the part's content type describes the decoded file.
          payload.append(
            hash,
            new File([bytesToBase64(new Uint8Array(asset.bytes))], hash, {
              type: staticAssetContentType(asset.path),
            }),
            hash,
          );
        }
        response = await this.executeRaw(
          '/workers/assets/upload?base64=true',
          { method: 'POST', body: payload },
          completionJwt,
        );
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new AssetUploadSessionExpiredError();
      }
      const finalBucket = bucketIndex === uploadBuckets.length - 1;
      const uploaded = await parseCloudflareEnvelope<{ jwt?: string }>(response);
      if (singleAssetUploads && !finalBucket && uploaded.jwt !== undefined) {
        throw new CloudflareAccountApiError('Cloudflare returned an invalid asset upload identity sequence.');
      }
      if (uploaded.jwt !== undefined || finalBucket) {
        completionJwt = requireAssetUploadJwt(uploaded.jwt);
        receivedCompletionJwt = true;
      }
    }
    if (!receivedCompletionJwt) {
      throw new CloudflareAccountApiError('Cloudflare did not return the completed asset upload identity.');
    }
    return completionJwt;
  }

  private async promoteWorkerVersion(workerName: string, workerVersionId: string, sourceSha256: string): Promise<void> {
    const promoted = await this.call<{ id?: string; versions?: Array<{ percentage?: number; version_id?: string }> }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
      {
        method: 'POST',
        body: JSON.stringify({
          strategy: 'percentage',
          versions: [{ percentage: 100, version_id: workerVersionId }],
          annotations: { 'workers/message': `CloudChef approved revision ${sourceSha256.slice(0, 12)}` },
        }),
      },
    );
    requireExactDeploymentVersion(promoted.versions, workerVersionId);
    if (!promoted.id || !UUID_PATTERN.test(promoted.id)) {
      throw new CloudflareAccountApiError('Cloudflare did not read back the promoted Worker deployment.');
    }
    const readback = await this.call<{
      id?: string;
      versions?: Array<{ percentage?: number; version_id?: string }>;
    }>(`/workers/scripts/${encodeURIComponent(workerName)}/deployments/${encodeURIComponent(promoted.id)}`, {
      method: 'GET',
    });
    if (readback.id !== promoted.id) {
      throw new CloudflareAccountApiError('Cloudflare did not read back the promoted Worker deployment.');
    }
    requireExactDeploymentVersion(readback.versions, workerVersionId);
  }

  /**
   * Cloudflare gates every `/containers` route on the Workers Paid entitlement and refuses an
   * ineligible account with its own upgrade instructions, so reading the account's container limits
   * settles the plan question without creating anything. The verdict is returned instead of thrown
   * because "Cloudflare did not answer" has to stay distinguishable from "Cloudflare said no".
   */
  async readWorkspaceContainersEntitlement(signal?: AbortSignal): Promise<WorkspaceContainersEntitlement> {
    let response: Response;
    try {
      response = await this.callRaw('/containers/me', {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal,
      });
    } catch (error) {
      return {
        status: 'undetermined',
        reason: `Cloudflare did not answer the Containers capability check: ${boundedProviderText(describeUnknownError(error))}`,
      };
    }
    const payload = await readBoundedJson<CloudflareEnvelope<unknown>>(response).catch(() => null);
    if (response.ok) {
      if (payload?.success === true && isRecord(payload.result) && isRecord(payload.result.limits)) {
        return { status: 'entitled' };
      }
      return {
        status: 'undetermined',
        reason: `Cloudflare returned an unreadable Containers account response. ${describeContainersAnswer(response.status, payload)}`,
      };
    }
    const message = cloudflareErrorMessage(payload);
    if (message && isWorkspacePlanRequiredMessage(message)) {
      // The upgrade destination is read from the wording Cloudflare sent, before redaction can
      // touch it; only the copy that travels onwards into logs and the UI is bounded.
      return {
        status: 'plan_required',
        message: boundedProviderText(message),
        upgradeUrl: workersPlanUpgradeUrl(message),
      };
    }
    return {
      status: 'undetermined',
      reason: `Cloudflare refused the Containers capability check. ${describeContainersAnswer(response.status, payload)}`,
    };
  }

  /**
   * The provider keys (BYOK) stored on one of the account's AI Gateways: names and masked previews
   * only, since Cloudflare never returns a key. A gateway that does not exist yet has none.
   */
  async listAiGatewayProviderKeys(gatewayId: string, signal?: AbortSignal): Promise<AiGatewayProviderKey[]> {
    const result = await this.callOptional<unknown>(
      `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs?per_page=100`,
      { method: 'GET', signal },
    );
    if (result === null) {
      return [];
    }
    const parsed = z.array(aiGatewayProviderKeySchema).safeParse(result);
    if (!parsed.success) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid AI Gateway provider keys.');
    }
    return parsed.data.map(aiGatewayProviderKey);
  }

  /**
   * Stores a new provider key on one of the account's AI Gateways, as its provider's default.
   * Cloudflare keeps it in the gateway's Secrets Store as `{gateway}_{provider}_{alias}`; CloudChef
   * never keeps it.
   */
  async addAiGatewayProviderKey(
    gatewayId: string,
    key: { providerSlug: string; alias: string; secret: string },
  ): Promise<AiGatewayProviderKey> {
    const body = { provider_slug: key.providerSlug, alias: key.alias, default_config: true, secret: key.secret };
    const result = await this.call<unknown>(`/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const parsed = aiGatewayProviderKeySchema.safeParse(result);
    if (!parsed.success) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid AI Gateway provider key.');
    }
    return aiGatewayProviderKey(parsed.data);
  }

  /** Removes a provider key from one of the account's AI Gateways; one already gone is not an error. */
  async deleteAiGatewayProviderKey(gatewayId: string, keyId: string): Promise<void> {
    await this.deleteOptional(
      `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs/${encodeURIComponent(keyId)}`,
    );
  }

  /**
   * Readies one of the account's AI Gateways to hold provider keys, which Cloudflare accepts only on a
   * gateway with authentication on and a Secrets Store linked. A gateway that has both is left as it
   * is. One missing either is written back whole, since an update replaces the gateway: every setting
   * its admins chose is kept, authentication is turned on, and `storeId` is linked if it has no store
   * yet. A gateway that does not exist yet is created ready. The answer is the store the gateway keeps
   * its keys in, and whether authentication was off before (or the gateway new).
   */
  async prepareAiGatewayForKeys(
    gatewayId: string,
    storeId: string,
  ): Promise<{ storeId: string; authenticationTurnedOn: boolean }> {
    const path = `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`;
    const found = await this.callOptional<unknown>(path, { method: 'GET' });
    if (found === null) {
      await this.call<unknown>('/ai-gateway/gateways', {
        method: 'POST',
        body: JSON.stringify({
          id: gatewayId,
          ...REQUIRED_AI_GATEWAY_SETTINGS,
          authentication: true,
          store_id: storeId,
        }),
      });
      return { storeId, authenticationTurnedOn: true };
    }
    const gateway = aiGatewaySettingsSchema.safeParse(found);
    if (!gateway.success) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid AI Gateway.');
    }
    const authentication = gateway.data.authentication === true;
    // Cloudflare reports "no store" as an empty string.
    const currentStoreId = z.string().min(1).safeParse(gateway.data.store_id).data ?? null;
    if (currentStoreId !== null && authentication) {
      return { storeId: currentStoreId, authenticationTurnedOn: false };
    }
    const linkedStoreId = currentStoreId ?? storeId;
    await this.call<unknown>(path, {
      method: 'PUT',
      body: JSON.stringify({
        ...writableGatewaySettings(gateway.data),
        authentication: true,
        store_id: linkedStoreId,
      }),
    });
    return { storeId: linkedStoreId, authenticationTurnedOn: !authentication };
  }

  /** The account's Secrets Stores, by id. */
  async listSecretsStores(): Promise<{ id: string }[]> {
    const stores = z
      .array(z.looseObject({ id: z.string().min(1).max(128) }))
      .safeParse(await this.listAllPages('/secrets_store/stores', 'Cloudflare returned invalid Secrets Stores.', 100));
    if (!stores.success) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid Secrets Stores.');
    }
    return stores.data.map(({ id }) => ({ id }));
  }

  /** Deletes a Secrets Store secret; one already gone is not an error. */
  async deleteSecret(storeId: string, secretId: string): Promise<void> {
    await this.deleteOptional(
      `/secrets_store/stores/${encodeURIComponent(storeId)}/secrets/${encodeURIComponent(secretId)}`,
    );
  }

  /** Every Secrets Store secret the account lets AI Gateway use: names and ids, never values. */
  async listAiGatewaySecrets(): Promise<SecretsStoreSecret[]> {
    const secrets: SecretsStoreSecret[] = [];
    for (const store of await this.listSecretsStores()) {
      const listed = z
        .array(secretsStoreSecretSchema)
        .safeParse(
          await this.listAllPages(
            `/secrets_store/stores/${encodeURIComponent(store.id)}/secrets`,
            'Cloudflare returned invalid Secrets Store secrets.',
            100,
          ),
        );
      if (!listed.success) {
        throw new CloudflareAccountApiError('Cloudflare returned invalid Secrets Store secrets.');
      }
      for (const secret of listed.data) {
        if (secret.scopes.includes(AI_GATEWAY_SECRET_SCOPE)) {
          secrets.push({ id: secret.id, name: secret.name, storeId: store.id });
        }
      }
    }
    return secrets;
  }

  async getWorkersSubdomain(): Promise<string> {
    const result = await this.call<{ subdomain?: string }>('/workers/subdomain', { method: 'GET' });
    if (!result.subdomain || !/^[a-z0-9-]+$/.test(result.subdomain)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Workers subdomain.');
    }
    return result.subdomain;
  }

  async deployWorkspaceRuntimeWorker(args: {
    workerName: string;
    source: string;
    controlPlaneSecret: string;
    runtimeVersion: string;
    databaseId: string;
    userId: string;
    connectionId: string;
    connectionGeneration: number;
    endpoint: string;
    /** An organization's account, shared with the other members' workspaces. */
    sharedAccount: boolean;
  }): Promise<{ namespaceId: string }> {
    requireWorkerName(args.workerName);
    if (!/^[a-f0-9]{64}$/.test(args.runtimeVersion) || args.controlPlaneSecret.length < 32) {
      throw new CloudflareAccountApiError('The workspace runtime identity is invalid.');
    }
    if (!args.userId) {
      throw new CloudflareAccountApiError('Workspace runtime credentials are required.');
    }
    const metadata = {
      main_module: 'workspace-runtime.mjs',
      compatibility_date: '2026-07-27',
      compatibility_flags: ['nodejs_compat'],
      containers: [{ class_name: 'ProjectWorkspace' }],
      bindings: [
        { type: 'durable_object_namespace', name: 'PROJECT_WORKSPACE', class_name: 'ProjectWorkspace' },
        { type: 'durable_object_namespace', name: 'BuilderAgent', class_name: 'BuilderAgent' },
        { type: 'd1', name: 'DB', id: args.databaseId },
        { type: 'ai', name: 'AI' },
        { type: 'secret_text', name: 'CONTROL_PLANE_SECRET', text: args.controlPlaneSecret },
        { type: 'plain_text', name: 'CLOUDFLARE_ACCOUNT_ID', text: this.accountId },
        { type: 'plain_text', name: 'CLOUDCHEF_USER_ID', text: args.userId },
        { type: 'plain_text', name: 'CLOUDCHEF_CONNECTION_ID', text: args.connectionId },
        {
          type: 'plain_text',
          name: 'CLOUDCHEF_CONNECTION_GENERATION',
          text: String(args.connectionGeneration),
        },
        { type: 'plain_text', name: 'CLOUDCHEF_USER_RUNTIME_ENDPOINT', text: args.endpoint },
        { type: 'plain_text', name: 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT', text: CLOUDCHEF_CONTROL_PLANE_ENDPOINT },
        { type: 'plain_text', name: 'CLOUDCHEF_USER_RUNTIME', text: '1' },
        { type: 'plain_text', name: 'CLOUDCHEF_SHARED_ACCOUNT', text: args.sharedAccount ? '1' : '0' },
        { type: 'plain_text', name: 'CLOUDCHEF_RUNTIME_VERSION', text: args.runtimeVersion },
      ],
      exports: {
        ProjectWorkspace: {
          type: 'durable-object',
          storage: 'sqlite',
        },
        BuilderAgent: {
          type: 'durable-object',
          storage: 'sqlite',
        },
      },
      observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 0.6 } },
      annotations: {
        'workers/message': `CloudChef user-owned workspace runtime ${args.runtimeVersion.slice(0, 12)}`,
        'workers/tag': args.runtimeVersion.slice(0, 64),
      },
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.set(
      'workspace-runtime.mjs',
      new Blob([args.source], { type: 'application/javascript+module' }),
      'workspace-runtime.mjs',
    );
    await this.uploadWorkerDirectly(args.workerName, form);
    const namespaces = await this.call<DurableObjectNamespaceReadback[]>(
      '/workers/durable_objects/namespaces?per_page=1000',
      { method: 'GET' },
    );
    const namespace = namespaces.find(
      (candidate) =>
        candidate.script === args.workerName &&
        candidate.class === 'ProjectWorkspace' &&
        candidate.use_sqlite === true &&
        candidate.id,
    );
    if (!namespace?.id) {
      throw new CloudflareAccountApiError('Cloudflare did not provision the Computer workspace namespace.');
    }
    return { namespaceId: namespace.id };
  }

  /** Upload and deploy in one request; the only path that creates a Worker or applies DO lifecycle. */
  private async uploadWorkerDirectly(workerName: string, form: FormData): Promise<string> {
    const uploaded = await parseCloudflareEnvelope<{ id?: string; etag?: string }>(
      await this.callRaw(
        `/workers/scripts/${encodeURIComponent(workerName)}?excludeScript=true&bindings_inherit=strict`,
        {
          method: 'PUT',
          body: form,
        },
      ),
    );
    if (
      uploaded.id !== workerName ||
      typeof uploaded.etag !== 'string' ||
      uploaded.etag.length < 1 ||
      uploaded.etag.length > 256
    ) {
      throw new CloudflareAccountApiError('Cloudflare did not read back the deployed Worker.');
    }
    const fullyRoutedVersions = fullyRoutedWorkerVersions(
      requireWorkerDeployments(
        await this.call<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/deployments`, { method: 'GET' }),
      ),
    );
    if (fullyRoutedVersions.length !== 1 || !UUID_PATTERN.test(fullyRoutedVersions[0]!.version_id)) {
      throw new CloudflareAccountApiError('Cloudflare returned an ambiguous Worker deployment.');
    }
    const workerVersionId = fullyRoutedVersions[0]!.version_id;
    // Prove the active deployment serves the bytes this request uploaded, not a concurrent write.
    const version = await this.call<{ id?: string; resources?: { script?: { etag?: string } } }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(workerVersionId)}`,
      { method: 'GET' },
    );
    if (version.id !== workerVersionId || version.resources?.script?.etag !== uploaded.etag) {
      throw new CloudflareAccountApiError('Cloudflare did not read back the deployed Worker.');
    }
    return workerVersionId;
  }

  async ensureWorkspaceRuntimeContainer(args: {
    applicationName: string;
    namespaceId: string;
    image: string;
  }): Promise<void> {
    requireWorkerName(args.applicationName);
    if (!/^[0-9a-f-]{32,64}$/i.test(args.namespaceId)) {
      throw new CloudflareAccountApiError('The workspace Sandbox namespace is invalid.');
    }
    const applications = await this.callContainer<unknown>('/applications', {
      method: 'GET',
    });
    const existing = existingContainerApplication(applications, args.applicationName);
    if (existing && existing.durable_objects.namespace_id !== args.namespaceId) {
      throw new CloudflareAccountApiError(
        'The workspace container name is already attached to a different Durable Object namespace.',
      );
    }
    const configuration = {
      configuration: {
        image: args.image,
        instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
        observability: { logs: { enabled: true } },
        wrangler_ssh: { enabled: false },
      },
      max_instances: PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
      constraints: { tiers: [1, 2] },
      scheduling_policy: 'default',
      rollout_active_grace_period: 0,
    };
    const result = existing
      ? await this.callContainer<ContainerApplicationReadback>(`/applications/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(configuration),
        })
      : await this.callContainer<ContainerApplicationReadback>('/applications', {
          method: 'POST',
          body: JSON.stringify({
            name: args.applicationName,
            ...configuration,
            instances: 0,
            durable_objects: { namespace_id: args.namespaceId },
          }),
        });
    if (!result.id || result.name !== args.applicationName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid workspace container application.');
    }
    if (existing) {
      const rollouts = await this.callContainer<unknown>(`/applications/${encodeURIComponent(existing.id)}/rollouts`, {
        method: 'GET',
      });
      const latestRollout = latestContainerApplicationRollout(rollouts);
      const matchingRollout =
        latestRollout && matchesWorkspaceContainerConfiguration(latestRollout.target_configuration, args.image)
          ? latestRollout
          : null;
      if (matchingRollout?.status === 'completed') {
        return;
      }
      const rolloutId =
        matchingRollout && ['pending', 'progressing'].includes(matchingRollout.status)
          ? matchingRollout.id
          : await this.createWorkspaceRuntimeContainerRollout(
              existing.id,
              args.applicationName,
              configuration.configuration,
            );
      await this.waitForWorkspaceRuntimeContainerRollout({
        applicationId: existing.id,
        applicationName: args.applicationName,
        rolloutId,
        image: args.image,
      });
    }
  }

  private async createWorkspaceRuntimeContainerRollout(
    applicationId: string,
    applicationName: string,
    targetConfiguration: WorkspaceContainerConfiguration,
  ): Promise<string> {
    const rollout = await this.callContainer<{ id?: string }>(
      `/applications/${encodeURIComponent(applicationId)}/rollouts`,
      {
        method: 'POST',
        body: JSON.stringify({
          description: `CloudChef workspace runtime update for ${applicationName}`,
          // A single 100% step is the direct-API equivalent of Wrangler's required --containers-rollout=immediate
          // cutover. Stable and @next Sandbox control protocols cannot coexist during a gradual rollout.
          strategy: 'rolling',
          target_configuration: targetConfiguration,
          step_percentage: 100,
          kind: 'full_auto',
        }),
      },
    );
    if (!rollout.id) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid workspace container rollout.');
    }
    return rollout.id;
  }

  private async waitForWorkspaceRuntimeContainerRollout(args: {
    applicationId: string;
    applicationName: string;
    rolloutId: string;
    image: string;
  }): Promise<void> {
    const deadline = Date.now() + CONTAINER_ROLLOUT_DEADLINE_MS;
    while (Date.now() < deadline) {
      const rollout = requireContainerApplicationRollout(
        await this.callContainer<unknown>(
          `/applications/${encodeURIComponent(args.applicationId)}/rollouts/${encodeURIComponent(args.rolloutId)}`,
          { method: 'GET' },
        ),
        args.rolloutId,
      );
      if (!matchesWorkspaceContainerConfiguration(rollout.target_configuration, args.image)) {
        throw new CloudflareAccountApiError('Cloudflare changed the workspace container rollout configuration.');
      }
      if (rollout.status === 'completed') {
        return;
      }
      if (!['pending', 'progressing'].includes(rollout.status)) {
        throw new CloudflareAccountApiError(
          `Cloudflare did not complete the workspace container rollout for ${args.applicationName}.`,
        );
      }
      await scheduler.wait(Math.min(CONTAINER_ROLLOUT_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    throw new CloudflareAccountApiError(
      `Cloudflare did not complete the workspace container rollout for ${args.applicationName} before the deadline.`,
    );
  }

  /** Serve the Worker's active version at its workers.dev address, and no earlier version anywhere. */
  async enableWorkerSubdomain(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    const path = `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`;
    requireServedWorkerSubdomain(
      await this.call<WorkerSubdomainState>(path, {
        method: 'POST',
        body: JSON.stringify({ enabled: true, previews_enabled: DEPLOYMENT_PREVIEW_URLS_ENABLED }),
      }),
    );
    requireServedWorkerSubdomain(await this.call<WorkerSubdomainState>(path, { method: 'GET' }));
  }

  /** Replace every trigger with CloudChef's single deterministic runtime-GC schedule. */
  async configureWorkspaceRuntimeGcSchedule(workerName: string): Promise<void> {
    await this.replaceWorkerSchedules(workerName, [USER_WORKSPACE_RUNTIME_GC_CRON]);
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const result = await this.callOptional<T>(path, init);
    if (result === null) {
      throw new CloudflareAccountApiError('Cloudflare resource was not found.');
    }
    return result;
  }

  private async listR2ObjectKeys(bucketName: string): Promise<string[]> {
    const listed = await this.callOptional<unknown>(
      `/r2/buckets/${encodeURIComponent(bucketName)}/objects?per_page=${R2_CLEANUP_BATCH_SIZE}`,
      { method: 'GET' },
    );
    if (listed === null) {
      return [];
    }
    if (!Array.isArray(listed)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 object list.');
    }
    return listed.map((value) => {
      if (!isRecord(value) || typeof value.key !== 'string' || value.key.length === 0 || value.key.length > 1_024) {
        throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 object list.');
      }
      return value.key;
    });
  }

  private async deleteOptional(path: string): Promise<void> {
    const response = await this.callRaw(path, { method: 'DELETE' });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const text = await readBoundedResponseText(response);
    if (!response.ok || text === null) {
      throw new CloudflareAccountApiError(`Cloudflare API request failed (${response.status}).`);
    }
    if (text.length === 0) {
      return;
    }
    try {
      const payload = JSON.parse(text) as CloudflareEnvelope<unknown>;
      if (payload.success === true) {
        return;
      }
      throw new CloudflareAccountApiError(
        payload.errors?.find((error) => error.message)?.message ||
          `Cloudflare API request failed (${response.status}).`,
      );
    } catch (error) {
      if (error instanceof CloudflareAccountApiError) {
        throw error;
      }
      throw new CloudflareAccountApiError('Cloudflare returned an invalid deletion response.');
    }
  }

  private async callOptional<T>(path: string, init: RequestInit): Promise<T | null> {
    const response = await this.callRaw(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const payload = await readBoundedJson<CloudflareEnvelope<T>>(response);
    if (response.status === 404) {
      return null;
    }
    return requireEnvelopeResult(payload, response).result;
  }

  /**
   * Read one listing page whole. `callOptional` returns only `result`, and pagination cannot be
   * followed without the counters and cursor that sit beside it.
   */
  private async callPage<T>(path: string): Promise<{ result: T; resultInfo: CloudflareResultInfo | undefined }> {
    const response = await this.callRaw(path, { method: 'GET', headers: { 'content-type': 'application/json' } });
    return requireEnvelopeResult(await readBoundedJson<CloudflareEnvelope<T>>(response), response);
  }

  private async callRaw(path: string, init: RequestInit): Promise<Response> {
    let response = await this.executeRaw(path, init, this.accessToken);
    if (response.status === 401 && this.refreshAccessToken) {
      await response.body?.cancel().catch(() => undefined);
      const refreshed = await this.refreshAccessToken();
      if (!refreshed || refreshed.length > 4_096) {
        throw new CloudflareAccountApiError('Cloudflare connection is unavailable.');
      }
      this.accessToken = refreshed;
      response = await this.executeRaw(path, init, refreshed);
    }
    return response;
  }

  private async executeRaw(path: string, init: RequestInit, bearer: string): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new CloudflareAccountApiError('Cloudflare API path is invalid.');
    }
    const response = await fetch(`${API_ROOT}/accounts/${encodeURIComponent(this.accountId)}${path}`, {
      ...init,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
      headers: {
        ...init.headers,
        authorization: `Bearer ${bearer}`,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareAccountApiError('Cloudflare API request redirected unexpectedly.');
    }
    return response;
  }

  private async callContainer<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.callRaw(`/containers${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const payload = await readBoundedJson<CloudflareEnvelope<T> | T | { error?: string; message?: string }>(response);
    if (!response.ok || payload === null) {
      throw new CloudflareAccountApiError(
        cloudflareErrorMessage(payload) || `Cloudflare Containers request failed (${response.status}).`,
      );
    }
    if (typeof payload === 'object' && !Array.isArray(payload) && 'success' in payload) {
      const envelope = payload as CloudflareEnvelope<T>;
      if (envelope.success !== true || envelope.result === undefined) {
        throw new CloudflareAccountApiError(cloudflareErrorMessage(payload) || 'Cloudflare Containers request failed.');
      }
      return envelope.result;
    }
    return payload as T;
  }
}

export class CloudflareAccountApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareAccountApiError';
  }
}

/** A migration the database already applied, under the same name, has different contents now. */
export class D1MigrationChangedError extends CloudflareAccountApiError {
  /** `appliedSql` is what the database applied under that name, when it recorded it. */
  constructor(
    readonly migrationName: string,
    readonly appliedSql: string | null = null,
  ) {
    super(`User-runtime D1 migration digest mismatch: ${migrationName}`);
    this.name = 'D1MigrationChangedError';
  }
}

class AssetUploadSessionExpiredError extends Error {}

/**
 * Cloudflare's own wording for an account whose plan excludes Containers. Matched rather than
 * status-coded because the Containers control plane answers 401 for a missing scope too, and only
 * the message separates "reauthorize" from "upgrade".
 */
function isWorkspacePlanRequiredMessage(message: string): boolean {
  return (
    /cloudflare\s+containers?/i.test(message) && /(workers\s+paid|paid\s+plan|upgrade\s+your\s+plan)/i.test(message)
  );
}

/** The upgrade destination Cloudflare names in its own refusal, so the product links where it points. */
function workersPlanUpgradeUrl(message: string): string | null {
  const match = /https:\/\/dash\.cloudflare\.com\/[^\s"'<>\\]*workers\/plans[^\s"'<>\\]*/i.exec(message);
  if (!match) {
    return null;
  }
  try {
    return new URL(match[0]).origin === 'https://dash.cloudflare.com' ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * The evidence an entitlement verdict CloudChef could not classify has to carry.
 *
 * Cloudflare answers a missing Containers scope and an ineligible plan on the same endpoint with
 * the same 401, and only the wording separates them, so `isWorkspacePlanRequiredMessage` is a
 * guess until a real Workers Free account refuses one of these checks. There is no such account
 * to test against here, so every unclassified answer records what it actually saw: the status,
 * Cloudflare's own numeric error codes, and its wording, so Workflow retries and logs preserve the
 * real answer instead of guessing at a second classification.
 */
function describeContainersAnswer(status: number, payload: CloudflareEnvelope<unknown> | null): string {
  const codes = cloudflareErrorCodes(payload);
  const wording = boundedProviderText(cloudflareErrorMessage(payload) ?? '');
  return [
    `status=${status}`,
    `codes=${codes.length > 0 ? codes.join(',') : 'none'}`,
    `wording=${wording ? JSON.stringify(wording) : 'none'}`,
  ].join(' ');
}

/** Cloudflare's own numeric error codes: the part of a refusal that carries no wording at all. */
function cloudflareErrorCodes(payload: CloudflareEnvelope<unknown> | null): number[] {
  if (!Array.isArray(payload?.errors)) {
    return [];
  }
  return payload.errors
    .map((error) => error?.code)
    .filter((code): code is number => typeof code === 'number' && Number.isInteger(code))
    .slice(0, 8);
}

/**
 * Provider text on its way into a log an operator reads: credential-shaped runs replaced, folded
 * onto one line, and hard-bounded. Redaction is by shape rather than by origin because the point
 * is to record wording nobody here has seen yet.
 */
function boundedProviderText(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_REDACTION_PATTERNS) {
    redacted = redacted.replaceAll(pattern, '[redacted]');
  }
  return redacted.replaceAll(/\s+/g, ' ').trim().slice(0, PROVIDER_TEXT_LIMIT);
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The resource `find` finds, or the one `create` makes. A create Cloudflare refuses because another
 * request made the same resource first finds that one instead.
 */
async function findOrCreate<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  if (existing) {
    return existing;
  }
  try {
    return await create();
  } catch (error) {
    if (!(error instanceof CloudflareAccountApiError)) {
      throw error;
    }
    const raced = await find();
    if (raced) {
      return raced;
    }
    throw error;
  }
}

function requireR2BucketName(name: string): void {
  if (!R2_BUCKET_NAME_PATTERN.test(name)) {
    throw new CloudflareAccountApiError('R2 bucket name is invalid.');
  }
}

/** A name Cloudflare accepts for a Worker, a D1 database or a KV namespace CloudChef manages. */
const CLOUDFLARE_RESOURCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function requireWorkerName(name: string): void {
  if (!CLOUDFLARE_RESOURCE_NAME_PATTERN.test(name)) {
    throw new CloudflareAccountApiError('Worker name is invalid.');
  }
}

function encodeR2ObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function isR2ObjectKeySafeForPathDeletion(key: string): boolean {
  return key.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function requireCloudflareResourceName(name: string): void {
  if (!CLOUDFLARE_RESOURCE_NAME_PATTERN.test(name)) {
    throw new CloudflareAccountApiError('Cloudflare resource name is invalid.');
  }
}

function d1ResultsContain(results: D1QueryResult[], predicate: (row: Record<string, unknown>) => boolean): boolean {
  return results.some((result) => result.results?.some((row) => isRecord(row) && predicate(row)) === true);
}

function d1MigrationReceipt(results: D1QueryResult[], name: string): { name: string; digest: string | null } | null {
  for (const result of results) {
    for (const row of result.results ?? []) {
      const receipt = d1MigrationReceiptSchema.safeParse(row);
      if (receipt.success && receipt.data.name === name) {
        return { name, digest: receipt.data.digest };
      }
    }
  }
  return null;
}

function cloudflareErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['message', 'error'] as const) {
    if (typeof value[key] === 'string' && value[key].length > 0) {
      return value[key];
    }
  }
  if (Array.isArray(value.errors)) {
    for (const error of value.errors) {
      if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) {
        return error.message;
      }
    }
  }
  return undefined;
}

async function parseCloudflareEnvelope<T>(response: Response): Promise<T> {
  return requireEnvelopeResult(await readBoundedJson<CloudflareEnvelope<T>>(response), response).result;
}

/** Accept a successful envelope, or raise the provider's own message in preference to a status. */
function requireEnvelopeResult<T>(payload: CloudflareEnvelope<T> | null, response: Response): EnvelopeResult<T> {
  if (!response.ok || payload?.success !== true || payload.result === undefined) {
    throw new CloudflareAccountApiError(
      payload?.errors?.find((error) => error.message)?.message || `Cloudflare API request failed (${response.status}).`,
    );
  }
  return { result: payload.result, resultInfo: payload.result_info };
}

async function readBoundedJson<T>(response: Response): Promise<T | null> {
  const text = await readBoundedResponseText(response);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** A Cloudflare response's text, or null past the size CloudChef reads, whose rest is left unread. */
async function readBoundedResponseText(response: Response): Promise<string | null> {
  try {
    return new TextDecoder().decode(
      await readBodyBytesWithLimit(response, MAX_CLOUDFLARE_RESPONSE_BYTES, 'Cloudflare response'),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return null;
    }
    throw error;
  }
}

function requireAssetUploadJwt(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ASSET_UPLOAD_JWT_BYTES) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid asset upload identity.');
  }
  return value;
}

function hasSingleAssetUploadProtocol(jwt: string): boolean {
  const payload = jwt.split('.')[1];
  if (!payload) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid current asset upload identity.');
  }
  let claims: unknown;
  try {
    const base64 = payload
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=');
    claims = JSON.parse(atob(base64));
  } catch {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid current asset upload identity.');
  }
  if (!isRecord(claims)) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid current asset upload identity.');
  }
  return claims.wrangler_single_asset_uploads === true;
}

function requireExactDeploymentVersion(
  versions: Array<{ percentage?: number; version_id?: string }> | undefined,
  expectedVersionId: string,
): void {
  if (versions?.length !== 1 || versions[0]?.percentage !== 100 || versions[0]?.version_id !== expectedVersionId) {
    throw new CloudflareAccountApiError('Cloudflare returned an ambiguous Worker deployment.');
  }
}

type WorkerSubdomainState = { enabled?: boolean; previews_enabled?: boolean };

/** The Worker serves at its workers.dev address, with preview URLs as CloudChef sets them. */
function requireServedWorkerSubdomain(state: WorkerSubdomainState): void {
  if (state.enabled !== true || state.previews_enabled !== DEPLOYMENT_PREVIEW_URLS_ENABLED) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
  }
}

function requireExactSchedules(result: unknown, expected: readonly string[]): void {
  const observed = requireSchedules(result);
  if (observed.length !== expected.length || observed.some((cron, index) => cron !== expected[index])) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid Worker schedules.');
  }
}

function requireSchedules(value: unknown): string[] {
  const parsed = workerSchedulesSchema.safeParse(value);
  if (!parsed.success) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid Worker schedules.');
  }
  return parsed.data.schedules.map((schedule) => schedule.cron);
}

/** The versions of the newest deployment Cloudflare lists that route all production traffic. */
function fullyRoutedWorkerVersions(deployments: WorkerDeploymentRow[]) {
  const deployment = deployments.sort((left, right) => right.created_on.localeCompare(left.created_on))[0];
  return deployment?.versions.filter((version) => version.percentage === 100) ?? [];
}

function requireWorkerDeployments(value: unknown): WorkerDeploymentRow[] {
  const parsed = workerDeploymentsSchema.safeParse(value);
  if (!parsed.success) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
  }
  return parsed.data.deployments;
}

function existingContainerApplication(
  value: unknown,
  applicationName: string,
): z.infer<typeof containerApplicationSchema> | null {
  const applications = containerApplicationsSchema.safeParse(value);
  if (!applications.success) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container applications.');
  }
  const matches = applications.data.filter((application) => application.name === applicationName);
  if (matches.length > 1) {
    throw new CloudflareAccountApiError('Cloudflare returned ambiguous workspace container applications.');
  }
  if (matches.length === 0) {
    return null;
  }
  const existing = containerApplicationSchema.safeParse(matches[0]);
  if (!existing.success) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container application.');
  }
  return existing.data;
}

function latestContainerApplicationRollout(value: unknown): Required<ContainerApplicationRolloutReadback> | null {
  if (!Array.isArray(value)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container rollouts.');
  }
  const rollouts = value.map((rollout) => {
    const parsed = containerApplicationRolloutSchema.safeParse(rollout);
    if (!parsed.success) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container rollouts.');
    }
    return parsed.data;
  });
  return rollouts.sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null;
}

function requireContainerApplicationRollout(
  value: unknown,
  rolloutId: string,
): Required<ContainerApplicationRolloutReadback> {
  const rollout = containerApplicationRolloutSchema.safeParse(value).data;
  if (rollout?.id !== rolloutId) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid workspace container rollout.');
  }
  return rollout;
}

function matchesWorkspaceContainerConfiguration(value: unknown, image: string): boolean {
  if (!isRecord(value) || value.image !== image) {
    return false;
  }
  const ssh = isRecord(value.wrangler_ssh) ? value.wrangler_ssh : null;
  const observability = isRecord(value.observability) ? value.observability : null;
  const logs = observability && isRecord(observability.logs) ? observability.logs : null;
  const disk = isRecord(value.disk) ? value.disk : null;
  // Cloudflare echoes either the tier name or the dimensions it resolves to, so both are
  // accepted - but both come from the policy, so changing the tier cannot leave this
  // recognising only the previous one.
  const configuredInstance =
    value.instance_type === PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE ||
    (value.vcpu === PROJECT_WORKSPACE_CONTAINER_DIMENSIONS.vcpu &&
      value.memory_mib === PROJECT_WORKSPACE_CONTAINER_DIMENSIONS.memoryMib &&
      disk?.size_mb === PROJECT_WORKSPACE_CONTAINER_DIMENSIONS.diskMb);
  return ssh?.enabled === false && logs?.enabled === true && configuredInstance;
}

function workerModuleContentType(path: string): string {
  return path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module';
}

const STATIC_ASSET_CONTENT_TYPES = new Map<string, string>([
  ['css', 'text/css'],
  ['gif', 'image/gif'],
  ['html', 'text/html'],
  ['ico', 'image/x-icon'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['js', 'text/javascript'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['mjs', 'text/javascript'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['txt', 'text/plain'],
  ['wasm', 'application/wasm'],
  ['webmanifest', 'application/manifest+json'],
  ['webp', 'image/webp'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['xml', 'application/xml'],
]);

function staticAssetContentType(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return STATIC_ASSET_CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
}

/** Provider ids are opaque, so only reject shapes that could not have been recorded. */
function requireProviderResourceId(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[^\w.-]/.test(value)) {
    throw new CloudflareAccountApiError('Cloudflare resource id is invalid.');
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
