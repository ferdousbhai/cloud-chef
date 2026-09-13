import { deploymentPlanResourceName, type DeploymentPlan, type DeploymentResourceType } from './deployment-plan';
import { deploymentAssetExtension, deploymentAssetHash, type DeploymentArtifactFile } from './deployment-artifact';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
  DEPLOYMENT_PREVIEW_URLS_ENABLED,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
} from './deployment-runtime-policy';
import { workspaceImageAdmissionError } from './workspace-image-reference';
import {
  PROJECT_WORKSPACE_CONTAINER_DIMENSIONS,
  PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
  PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
} from './project-workspace-container-policy';
import { GHOSTBUILD_CONTROL_PLANE_ENDPOINT, USER_WORKSPACE_RUNTIME_GC_CRON } from './user-workspace-runtime-policy';
import { bytesToBase64, sha256Hex } from '~/lib/hex-digest';
import type { CloudflareOAuthScopeGrantStatus } from './cloudflare-oauth-scope-manifest';

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
const R2_CLEANUP_LIFECYCLE_ID = 'ghostbuild-project-deletion';
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

type WorkerResourceReadback = {
  id?: string;
  name?: string;
};

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
  assets?: { jwt: string };
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
  workersAi: boolean;
  appAgent: boolean;
  d1DatabaseId?: string;
  agentSecurityD1DatabaseId?: string;
  r2BucketName?: string;
  kvNamespaceId?: string;
};

type D1QueryResult = {
  success?: boolean;
  results?: unknown[];
};

export class UserCloudflareAccountApi {
  constructor(
    private readonly accountId: string,
    private accessToken: string,
    private readonly request: typeof fetch = fetch,
    private readonly authorizeRequest?: () => Promise<void>,
    private readonly refreshAccessToken?: () => Promise<string>,
  ) {
    if (!accountId || !accessToken) {
      throw new Error('Cloudflare account credentials are required.');
    }
  }

  async ensureD1Database(resourceName: string): Promise<{ id: string; name: string }> {
    requireCloudflareResourceName(resourceName);
    const databases = await this.call<unknown>(`/d1/database?name=${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    const existingId = existingD1DatabaseId(databases, resourceName);
    if (existingId) {
      return { id: existingId, name: resourceName };
    }
    const result = await this.call<{ uuid?: string; name?: string }>('/d1/database', {
      method: 'POST',
      body: JSON.stringify({ name: resourceName }),
    });
    if (!result.uuid || result.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
    }
    return { id: result.uuid, name: result.name };
  }

  async executeD1(databaseId: string, sql: string, params: unknown[] = []): Promise<D1QueryResult[]> {
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
    const result = await this.call<unknown>(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (
      !Array.isArray(result) ||
      result.length === 0 ||
      result.some(
        (query) =>
          !isRecord(query) || query.success !== true || (query.results !== undefined && !Array.isArray(query.results)),
      )
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned an unsuccessful D1 query result.');
    }
    return result;
  }

  async applyD1Migrations(databaseId: string, migrations: readonly { name: string; sql: string }[]): Promise<void> {
    await this.executeD1(
      databaseId,
      `CREATE TABLE IF NOT EXISTS ghostbuild_runtime_migrations (
         name TEXT PRIMARY KEY NOT NULL,
         applied_at INTEGER NOT NULL,
         digest TEXT
       )`,
    );
    await this.ensureD1MigrationDigestColumn(databaseId);
    // One receipt read for the whole set rather than one per migration. Applying migration N
    // cannot change migration N+1's receipt, so the extra round trips bought nothing — and this
    // path runs on every runtime upgrade for every existing account, where the answer is always
    // "all of them are already applied" and the reads were the entire cost.
    const receipts = await this.executeD1(databaseId, 'SELECT name, digest FROM ghostbuild_runtime_migrations');
    for (const migration of migrations) {
      if (!/^\d{4}_.+\.sql$/.test(migration.name) || !migration.sql.trim()) {
        throw new CloudflareAccountApiError('Invalid user-runtime D1 migration.');
      }
      const digest = await sha256Hex(migration.sql);
      const receipt = d1MigrationReceipt(receipts, migration.name);
      if (receipt?.digest === digest) {
        continue;
      }
      if (receipt?.digest) {
        throw new CloudflareAccountApiError(`User-runtime D1 migration digest mismatch: ${migration.name}`);
      }
      if (receipt) {
        throw new CloudflareAccountApiError(`User-runtime D1 migration receipt lacks a digest: ${migration.name}`);
      }
      try {
        await this.executeD1Batch(databaseId, [
          { sql: migration.sql },
          {
            sql: 'INSERT INTO ghostbuild_runtime_migrations (name, applied_at, digest) VALUES (?, ?, ?)',
            params: [migration.name, Date.now(), digest],
          },
        ]);
      } catch (error) {
        // A lost acknowledgement after D1 commits must not replay a
        // non-idempotent migration. Resolve the ambiguity by reading its
        // transactional marker before surfacing the original failure.
        const committed = await this.executeD1(
          databaseId,
          'SELECT name, digest FROM ghostbuild_runtime_migrations WHERE name = ?',
          [migration.name],
        ).catch((readError) => {
          console.warn('Unable to verify D1 migration commit', readError);
          return [];
        });
        const committedReceipt = d1MigrationReceipt(committed, migration.name);
        if (committedReceipt?.digest === digest) {
          continue;
        }
        if (committedReceipt?.digest) {
          throw new CloudflareAccountApiError(`User-runtime D1 migration digest mismatch: ${migration.name}`);
        }
        throw error;
      }
    }
  }

  private async ensureD1MigrationDigestColumn(databaseId: string): Promise<void> {
    const columns = await this.executeD1(databaseId, 'PRAGMA table_info(ghostbuild_runtime_migrations)');
    if (d1ResultsContain(columns, (row) => row.name === 'digest')) {
      return;
    }
    await this.executeD1(databaseId, 'ALTER TABLE ghostbuild_runtime_migrations ADD COLUMN digest TEXT');
  }

  async ensureD1ForPlan(
    plan: DeploymentPlan,
    logicalName: 'DB' | 'DB_PREVIEW' | 'AGENT_SECURITY_DB' | 'AGENT_SECURITY_DB_PREVIEW' = 'DB',
  ): Promise<{ id: string; name: string }> {
    return this.ensureD1Database(requirePlanResourceName(plan, 'd1', logicalName));
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

  async ensureR2ForPlan(plan: DeploymentPlan): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'r2', 'APP_STORAGE');
    return this.ensureR2Bucket(resourceName);
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

  async ensureR2Bucket(resourceName: string): Promise<{ id: string; name: string }> {
    requireR2BucketName(resourceName);
    const existing = await this.readR2Bucket(resourceName);
    if (existing) {
      return existing;
    }
    try {
      return await this.createR2Bucket(resourceName);
    } catch (error) {
      if (!(error instanceof CloudflareAccountApiError)) {
        throw error;
      }
      const raced = await this.readR2Bucket(resourceName);
      if (raced) {
        return raced;
      }
      throw error;
    }
  }

  async ensureKvForPlan(plan: DeploymentPlan): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'kv', 'APP_CACHE');
    const existing = await this.findKvNamespace(resourceName);
    if (existing) {
      return existing;
    }
    try {
      const created = await this.call<{ id?: string; title?: string }>('/storage/kv/namespaces', {
        method: 'POST',
        body: JSON.stringify({ title: resourceName }),
      });
      if (!created.id || !/^[a-f0-9]{32}$/.test(created.id) || created.title !== resourceName) {
        throw new CloudflareAccountApiError('Cloudflare returned an invalid KV namespace.');
      }
      return { id: created.id, name: resourceName };
    } catch (error) {
      if (!(error instanceof CloudflareAccountApiError)) {
        throw error;
      }
      const raced = await this.findKvNamespace(resourceName);
      if (raced) {
        return raced;
      }
      throw error;
    }
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

  /** Remove a Ghostbuild-managed Worker and its script-owned Durable Objects. */
  async deleteManagedWorker(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    await this.deleteOptional(`/workers/scripts/${encodeURIComponent(workerName)}?force=true`);
  }

  /** The id Cloudflare holds for a database name, or null when the account has no such database. */
  async findD1DatabaseId(resourceName: string): Promise<string | null> {
    requireCloudflareResourceName(resourceName);
    const databases = await this.call<unknown>(`/d1/database?name=${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    return existingD1DatabaseId(databases, resourceName);
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
  async listKvNamespaces(): Promise<{ id: string; name: string }[]> {
    const namespaces = await this.listAllPages('/storage/kv/namespaces', 'Cloudflare returned invalid KV namespaces.');
    return namespaces.flatMap((value) =>
      isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string'
        ? [{ id: value.id, name: value.title }]
        : [],
    );
  }

  /**
   * Read every page of a page-numbered account listing.
   *
   * Cloudflare is inconsistent about `result_info` - D1 reports `total_count` without
   * `total_pages`, others report both - so whichever total it offers decides, and a full page is
   * the fallback signal when it offers neither.
   */
  private async listAllPages(path: string, invalidMessage: string): Promise<unknown[]> {
    const listed: unknown[] = [];
    for (let page = 1; page <= MAX_ACCOUNT_LIST_PAGES; page += 1) {
      const { result, resultInfo } = await this.callPage<unknown>(
        `${path}?page=${page}&per_page=${ACCOUNT_LIST_PAGE_SIZE}`,
      );
      if (!Array.isArray(result)) {
        throw new CloudflareAccountApiError(invalidMessage);
      }
      listed.push(...result);
      const more =
        typeof resultInfo?.total_pages === 'number'
          ? page < resultInfo.total_pages
          : typeof resultInfo?.total_count === 'number'
            ? listed.length < resultInfo.total_count
            : result.length >= ACCOUNT_LIST_PAGE_SIZE;
      // An empty page cannot be followed by anything this walk could use.
      if (!more || result.length === 0) {
        return listed;
      }
    }
    throw new CloudflareAccountApiError(ACCOUNT_LIST_TOO_LONG);
  }

  /** Upload an immutable version, then promote exactly that version to production. */
  async deployManagedWorker(args: ManagedWorkerVersionArgs): Promise<void> {
    const form = await this.managedWorkerUploadForm(args);
    // Cloudflare rejects a version upload for a Worker that has never been deployed, and applies
    // Durable Object class lifecycle only through a deployment, so both cases publish directly.
    if (args.appAgent || !(await this.hasWorkerDeployment(args.workerName))) {
      await this.uploadWorkerDirectly(args.workerName, form);
      return;
    }
    const workerVersionId = await this.uploadWorkerVersion(args.workerName, form);
    await this.promoteWorkerVersion(args.workerName, workerVersionId, args.sourceSha256);
  }

  /** Upload an immutable version without creating a deployment and return its versioned preview URL. */
  async previewManagedWorker(args: ManagedWorkerVersionArgs): Promise<{ workerVersionId: string; previewUrl: string }> {
    if (!(await this.hasWorkerDeployment(args.workerName))) {
      // The legacy Versions API cannot create a Worker resource. Create that empty control-plane
      // resource through Cloudflare's resource API first; it carries no code and creates no
      // deployment, so the generated revision remains an unpromoted preview version.
      await this.ensureManagedWorkerResource(args.workerName);
    }
    const workerVersionId = await this.uploadWorkerVersion(args.workerName, await this.managedWorkerUploadForm(args));
    const previewUrl = await this.readManagedWorkerPreviewUrl(args.workerName, workerVersionId);
    return { workerVersionId, previewUrl };
  }

  async readManagedWorkerPreviewUrl(workerName: string, workerVersionId: string): Promise<string> {
    requireWorkerName(workerName);
    if (!UUID_PATTERN.test(workerVersionId)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Worker version identity.');
    }
    await this.enableWorkerPreviewUrls(workerName);
    const version = await this.call<{ id?: string; metadata?: { has_preview?: boolean } }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(workerVersionId)}`,
      { method: 'GET' },
    );
    if (version.id !== workerVersionId || version.metadata?.has_preview !== true) {
      // Cloudflare does not generate preview URLs for every Worker shape (Durable Object Workers
      // are one documented exclusion), so an unpreviewable version fails here rather than at a 404.
      throw new CloudflareAccountApiError('Cloudflare did not make the managed Worker version previewable.');
    }
    const workersSubdomain = await this.getWorkersSubdomain();
    // The Versions API exposes the version identity and preview availability, but not the URL.
    // Cloudflare documents this deterministic hostname for versioned preview URLs.
    return `https://${workerVersionId.slice(0, 8)}-${workerName}.${workersSubdomain}.workers.dev`;
  }

  private async managedWorkerUploadForm(args: ManagedWorkerVersionArgs): Promise<FormData> {
    requireWorkerName(args.workerName);
    const expectedMain = args.projectType === 'worker' ? 'server.js' : 'index.js';
    if (
      args.mainModule !== expectedMain ||
      !/^[a-f0-9]{64}$/.test(args.sourceSha256) ||
      args.modules.filter((module) => module.path === expectedMain).length !== 1 ||
      (args.kvNamespaceId !== undefined && !/^[a-f0-9]{32}$/.test(args.kvNamespaceId)) ||
      (args.projectType === 'worker' && args.assets.length !== 0)
    ) {
      throw new CloudflareAccountApiError('Managed Worker deployment artifact is invalid.');
    }

    const assetJwt =
      args.projectType === 'web_app' ? await this.uploadStaticAssets(args.workerName, args.assets) : undefined;
    const bindings: Array<Record<string, unknown>> = [
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
      main_module: expectedMain,
      compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
      compatibility_flags: [...DEPLOYMENT_COMPATIBILITY_FLAGS],
      bindings,
      observability: DEPLOYMENT_OBSERVABILITY,
      annotations: {
        'workers/message': `Ghostbuild approved revision ${args.sourceSha256.slice(0, 12)}`,
        'workers/tag': args.sourceSha256,
      },
    };
    if (assetJwt) {
      metadata.assets = { jwt: assetJwt };
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

  /** Ensure the named Worker exists without uploading code or creating a production deployment. */
  private async ensureManagedWorkerResource(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    const path = `/workers/workers/${encodeURIComponent(workerName)}`;
    const existing = await this.callOptional<WorkerResourceReadback>(path, { method: 'GET' });
    if (existing !== null) {
      requireManagedWorkerResource(existing, workerName);
      return;
    }

    try {
      const created = await this.call<WorkerResourceReadback>('/workers/workers', {
        method: 'POST',
        body: JSON.stringify({
          name: workerName,
          observability: DEPLOYMENT_OBSERVABILITY,
          subdomain: { enabled: false, previews_enabled: DEPLOYMENT_PREVIEW_URLS_ENABLED },
        }),
      });
      requireManagedWorkerResource(created, workerName);
    } catch (error) {
      // A replay may race another publication that created the same deterministic Worker. Accept
      // only the exact resource now visible at that name; otherwise preserve the provider error.
      const raced = await this.callOptional<WorkerResourceReadback>(path, { method: 'GET' });
      if (raced === null) {
        throw error;
      }
      requireManagedWorkerResource(raced, workerName);
    }
  }

  /** Replace every trigger with the one server-owned AppAgent cleanup schedule, or none. */
  async configureManagedWorkerSchedule(workerName: string, appAgent: boolean): Promise<void> {
    requireWorkerName(workerName);
    const expected = appAgent ? [DEPLOYMENT_SECURITY_CLEANUP_CRON] : [];
    const result = await this.call<{ schedules?: Array<{ cron?: string }> }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
      {
        method: 'PUT',
        body: JSON.stringify(expected.map((cron) => ({ cron }))),
      },
    );
    requireExactSchedules(result, expected);
    const readback = await this.call<{ schedules?: Array<{ cron?: string }> }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
      { method: 'GET' },
    );
    requireExactSchedules(readback, expected);
  }

  private async readWorkerSubdomainState(workerName: string): Promise<{ enabled: boolean; previewsEnabled: boolean }> {
    const state = await this.call<{ enabled?: boolean; previews_enabled?: boolean }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      { method: 'GET' },
    );
    if (
      (state.enabled !== true && state.enabled !== false) ||
      (state.previews_enabled !== true && state.previews_enabled !== false)
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
    return { enabled: state.enabled, previewsEnabled: state.previews_enabled };
  }

  private async readExactWorkerSubdomainState(workerName: string): Promise<{ enabled: true; previewsEnabled: true }> {
    const state = await this.readWorkerSubdomainState(workerName);
    if (state.enabled !== true || state.previewsEnabled !== DEPLOYMENT_PREVIEW_URLS_ENABLED) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
    return { enabled: true, previewsEnabled: true };
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
          annotations: { 'workers/message': `Ghostbuild approved revision ${sourceSha256.slice(0, 12)}` },
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

  async getAiGatewayCreditBalance(signal?: AbortSignal): Promise<number> {
    const result = await this.call<{ balance?: unknown }>('/ai-gateway/billing/credit-balance', {
      method: 'GET',
      signal,
    });
    if (typeof result.balance !== 'number' || !Number.isFinite(result.balance)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid AI Gateway credit balance.');
    }
    return result.balance;
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
    oauthScopeGrantStatus: CloudflareOAuthScopeGrantStatus;
    endpoint: string;
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
        { type: 'plain_text', name: 'GHOSTBUILD_USER_ID', text: args.userId },
        { type: 'plain_text', name: 'GHOSTBUILD_CONNECTION_ID', text: args.connectionId },
        {
          type: 'plain_text',
          name: 'GHOSTBUILD_CONNECTION_GENERATION',
          text: String(args.connectionGeneration),
        },
        {
          type: 'plain_text',
          name: 'GHOSTBUILD_OAUTH_SCOPE_GRANT_STATUS',
          text: args.oauthScopeGrantStatus,
        },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_RUNTIME_ENDPOINT', text: args.endpoint },
        { type: 'plain_text', name: 'GHOSTBUILD_CONTROL_PLANE_ENDPOINT', text: GHOSTBUILD_CONTROL_PLANE_ENDPOINT },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_RUNTIME', text: '1' },
        { type: 'plain_text', name: 'GHOSTBUILD_RUNTIME_VERSION', text: args.runtimeVersion },
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
        'workers/message': `Ghostbuild user-owned workspace runtime ${args.runtimeVersion.slice(0, 12)}`,
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
  private async uploadWorkerDirectly(workerName: string, form: FormData): Promise<void> {
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
    const { fullyRoutedVersions } = newestWorkerDeployment(
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
  }

  async ensureWorkspaceRuntimeContainer(args: {
    applicationName: string;
    namespaceId: string;
    image: string;
    maxInstances?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }): Promise<void> {
    requireWorkerName(args.applicationName);
    if (!/^[0-9a-f-]{32,64}$/i.test(args.namespaceId)) {
      throw new CloudflareAccountApiError('The workspace Sandbox namespace is invalid.');
    }
    const inadmissibleImage = workspaceImageAdmissionError(args.image, this.accountId);
    if (inadmissibleImage) {
      throw new CloudflareAccountApiError(inadmissibleImage);
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
      max_instances: args.maxInstances ?? PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
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
        sleep: args.sleep,
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
          description: `Ghostbuild workspace runtime update for ${applicationName}`,
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
    sleep?: (milliseconds: number) => Promise<void>;
  }): Promise<void> {
    const sleep = args.sleep ?? ((milliseconds: number) => scheduler.wait(milliseconds));
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
      await sleep(Math.min(CONTAINER_ROLLOUT_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    throw new CloudflareAccountApiError(
      `Cloudflare did not complete the workspace container rollout for ${args.applicationName} before the deadline.`,
    );
  }

  async enableWorkerSubdomain(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    const state = await this.call<{ enabled?: boolean; previews_enabled?: boolean }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      {
        method: 'POST',
        body: JSON.stringify({ enabled: true, previews_enabled: DEPLOYMENT_PREVIEW_URLS_ENABLED }),
      },
    );
    if (state.enabled !== true || state.previews_enabled !== DEPLOYMENT_PREVIEW_URLS_ENABLED) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
    await this.readExactWorkerSubdomainState(workerName);
  }

  /** Enable immutable preview URLs without making an undeployed Worker's production hostname live. */
  private async enableWorkerPreviewUrls(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    const current = await this.readWorkerSubdomainState(workerName);
    const expected = { enabled: current.enabled, previews_enabled: DEPLOYMENT_PREVIEW_URLS_ENABLED };
    const state = await this.call<{ enabled?: boolean; previews_enabled?: boolean }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      { method: 'POST', body: JSON.stringify(expected) },
    );
    if (state.enabled !== expected.enabled || state.previews_enabled !== expected.previews_enabled) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
    const readback = await this.readWorkerSubdomainState(workerName);
    if (readback.enabled !== expected.enabled || readback.previewsEnabled !== expected.previews_enabled) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
  }

  /** Replace every trigger with Ghostbuild's single deterministic runtime-GC schedule. */
  async configureWorkspaceRuntimeGcSchedule(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    const result = await this.call<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/schedules`, {
      method: 'PUT',
      body: JSON.stringify([{ cron: USER_WORKSPACE_RUNTIME_GC_CRON }]),
    });
    if (!isRecord(result) || !Array.isArray(result.schedules) || result.schedules.length !== 1) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace runtime schedules.');
    }
    const schedule = result.schedules[0];
    if (
      !isRecord(schedule) ||
      schedule.cron !== USER_WORKSPACE_RUNTIME_GC_CRON ||
      (schedule.created_on !== undefined && typeof schedule.created_on !== 'string') ||
      (schedule.modified_on !== undefined && typeof schedule.modified_on !== 'string')
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace runtime schedules.');
    }
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const result = await this.callOptional<T>(path, init);
    if (result === null) {
      throw new CloudflareAccountApiError('Cloudflare resource was not found.');
    }
    return result;
  }

  private async listR2ObjectKeys(bucketName: string): Promise<string[]> {
    const response = await this.callRaw(
      `/r2/buckets/${encodeURIComponent(bucketName)}/objects?per_page=${R2_CLEANUP_BATCH_SIZE}`,
      { method: 'GET' },
    );
    const payload = await readBoundedJson<CloudflareEnvelope<unknown>>(response);
    if (response.status === 404) {
      return [];
    }
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.result)) {
      const providerMessage = payload?.errors?.find((error) => error.message)?.message;
      throw new CloudflareAccountApiError(providerMessage || `Cloudflare API request failed (${response.status}).`);
    }
    return payload.result.map((value) => {
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
    const text = await readBoundedResponseText(response, MAX_CLOUDFLARE_RESPONSE_BYTES);
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
    await this.authorizeRequest?.();
    let response = await this.executeRaw(path, init, this.accessToken);
    if (response.status === 401 && this.refreshAccessToken) {
      await response.body?.cancel().catch(() => undefined);
      const refreshed = await this.refreshAccessToken();
      if (!refreshed || refreshed.length > 4_096) {
        throw new CloudflareAccountApiError('Cloudflare connection is unavailable.');
      }
      this.accessToken = refreshed;
      await this.authorizeRequest?.();
      response = await this.executeRaw(path, init, refreshed);
    }
    return response;
  }

  private async executeRaw(path: string, init: RequestInit, bearer: string): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new CloudflareAccountApiError('Cloudflare API path is invalid.');
    }
    const execute = this.request;
    const response = await execute(`${API_ROOT}/accounts/${encodeURIComponent(this.accountId)}${path}`, {
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
 * The evidence an entitlement verdict Ghostbuild could not classify has to carry.
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

function requirePlanResourceName(plan: DeploymentPlan, type: DeploymentResourceType, logicalName: string): string {
  const name = deploymentPlanResourceName(plan, type, logicalName);
  if (!name) {
    throw new CloudflareAccountApiError(`Approved deployment plan has an invalid ${type} resource.`);
  }
  return name;
}

function requireR2BucketName(name: string): void {
  if (!R2_BUCKET_NAME_PATTERN.test(name)) {
    throw new CloudflareAccountApiError('R2 bucket name is invalid.');
  }
}

function requireWorkerName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new CloudflareAccountApiError('Worker name is invalid.');
  }
}

function requireManagedWorkerResource(resource: WorkerResourceReadback, workerName: string): void {
  if (resource.name !== workerName || !/^[a-f0-9]{32}$/i.test(resource.id ?? '')) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid managed Worker resource.');
  }
}

function encodeR2ObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function isR2ObjectKeySafeForPathDeletion(key: string): boolean {
  return key.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function requireCloudflareResourceName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new CloudflareAccountApiError('Cloudflare resource name is invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function d1ResultsContain(results: D1QueryResult[], predicate: (row: Record<string, unknown>) => boolean): boolean {
  return results.some((result) => result.results?.some((row) => isRecord(row) && predicate(row)) === true);
}

function d1MigrationReceipt(results: D1QueryResult[], name: string): { name: string; digest: string | null } | null {
  for (const result of results) {
    for (const row of result.results ?? []) {
      if (isRecord(row) && row.name === name && (typeof row.digest === 'string' || row.digest === null)) {
        return { name, digest: row.digest };
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
  const contentLength = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CLOUDFLARE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await readBoundedResponseText(response, MAX_CLOUDFLARE_RESPONSE_BYTES);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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

function requireExactSchedules(result: unknown, expected: readonly string[]): void {
  const observed = requireSchedules(result);
  if (observed.length !== expected.length || observed.some((cron, index) => cron !== expected[index])) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker schedules.');
  }
}

function requireSchedules(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.schedules)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker schedules.');
  }
  return value.schedules.map((schedule) => {
    if (!isRecord(schedule) || typeof schedule.cron !== 'string' || schedule.cron.length === 0) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker schedules.');
    }
    return schedule.cron;
  });
}

function existingD1DatabaseId(value: unknown, resourceName: string): string | null {
  if (!Array.isArray(value)) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource list.');
  }
  const databases = value.map((database) => {
    if (
      !isRecord(database) ||
      typeof database.name !== 'string' ||
      database.name.length === 0 ||
      typeof database.uuid !== 'string' ||
      database.uuid.length === 0 ||
      database.uuid.length > 256
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
    }
    return { name: database.name, uuid: database.uuid };
  });
  const matches = databases.filter((database) => database.name === resourceName);
  if (matches.length > 1) {
    throw new CloudflareAccountApiError('Cloudflare returned an ambiguous D1 resource list.');
  }
  const existing = matches[0];
  if (!existing) {
    return null;
  }
  return existing.uuid;
}

/** The newest deployment Cloudflare lists, and the versions it routes all production traffic to. */
function newestWorkerDeployment(deployments: WorkerDeploymentRow[]) {
  const deployment = deployments.sort((left, right) => right.created_on.localeCompare(left.created_on))[0];
  return {
    deployment,
    fullyRoutedVersions: deployment?.versions.filter((version) => version.percentage === 100) ?? [],
  };
}

type WorkerDeploymentRow = {
  id: string;
  created_on: string;
  versions: Array<{ percentage: number; version_id: string }>;
};

function requireWorkerDeployments(value: unknown): WorkerDeploymentRow[] {
  if (!isRecord(value) || !Array.isArray(value.deployments)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
  }
  return value.deployments.map((deployment) => {
    if (
      !isRecord(deployment) ||
      typeof deployment.id !== 'string' ||
      deployment.id.length === 0 ||
      typeof deployment.created_on !== 'string' ||
      deployment.created_on.length === 0 ||
      !Array.isArray(deployment.versions)
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
    }
    const versions = deployment.versions.map((version) => {
      if (
        !isRecord(version) ||
        typeof version.percentage !== 'number' ||
        !Number.isFinite(version.percentage) ||
        typeof version.version_id !== 'string' ||
        version.version_id.length === 0
      ) {
        throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
      }
      return { percentage: version.percentage, version_id: version.version_id };
    });
    return { id: deployment.id, created_on: deployment.created_on, versions };
  });
}

function existingContainerApplication(
  value: unknown,
  applicationName: string,
): Required<Pick<ContainerApplicationReadback, 'id' | 'name' | 'durable_objects'>> | null {
  if (!Array.isArray(value)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container applications.');
  }
  const applications = value.map((application) => {
    if (!isRecord(application) || typeof application.name !== 'string' || application.name.length === 0) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container applications.');
    }
    return application;
  });
  const matches = applications.filter((application) => application.name === applicationName);
  if (matches.length > 1) {
    throw new CloudflareAccountApiError('Cloudflare returned ambiguous workspace container applications.');
  }
  const existing = matches[0];
  if (!existing) {
    return null;
  }
  if (
    typeof existing.id !== 'string' ||
    existing.id.length === 0 ||
    !isRecord(existing.durable_objects) ||
    typeof existing.durable_objects.namespace_id !== 'string' ||
    existing.durable_objects.namespace_id.length === 0
  ) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container application.');
  }
  return {
    id: existing.id,
    name: applicationName,
    durable_objects: { namespace_id: existing.durable_objects.namespace_id },
  };
}

function latestContainerApplicationRollout(value: unknown): Required<ContainerApplicationRolloutReadback> | null {
  if (!Array.isArray(value)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container rollouts.');
  }
  const rollouts = value.map((rollout) => {
    if (
      !isRecord(rollout) ||
      typeof rollout.id !== 'string' ||
      typeof rollout.created_at !== 'string' ||
      typeof rollout.status !== 'string' ||
      !isRecord(rollout.target_configuration)
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container rollouts.');
    }
    return {
      id: rollout.id,
      created_at: rollout.created_at,
      status: rollout.status,
      target_configuration: rollout.target_configuration,
    };
  });
  return rollouts.sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null;
}

function requireContainerApplicationRollout(
  value: unknown,
  rolloutId: string,
): Required<ContainerApplicationRolloutReadback> {
  if (
    !isRecord(value) ||
    value.id !== rolloutId ||
    typeof value.created_at !== 'string' ||
    typeof value.status !== 'string' ||
    !isRecord(value.target_configuration)
  ) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid workspace container rollout.');
  }
  return {
    id: rolloutId,
    created_at: value.created_at,
    status: value.status,
    target_configuration: value.target_configuration,
  };
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

/** Parse a Cloudflare ISO-8601 timestamp into epoch millis, or null when it is absent or invalid. */
