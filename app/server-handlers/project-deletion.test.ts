import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_CLOUDFLARE_OAUTH_SCOPES } from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';
import type { ProjectDeletionApi } from '~/lib/.server/cloudflare/project-deletion';
import type { WorkerBinding } from '~/lib/.server/cloudflare/user-account-api';
import { ORG, teamFixture } from '~/test/project-fixture';
import {
  deleteProjectAction,
  projectDeletionPreviewAction,
  runtimeDeletableProjectAction,
  type DeleteProjectRepository,
} from './project-deletion';

const SITE = '44444444-4444-4444-8444-444444444444';

/** An account with the project's Worker, another Worker sharing one bucket, and CloudChef's own runtime. */
function account(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const bindings = new Map<string, WorkerBinding[]>([
    [
      'storefront',
      [
        { kind: 'd1', id: 'db-1' },
        { kind: 'r2', bucket: 'shop-files' },
        { kind: 'r2', bucket: 'shared-files' },
        { kind: 'kv', id: 'kv-1' },
        { kind: 'queue', name: 'orders' },
        { kind: 'queue', name: 'events' },
        { kind: 'queue', name: 'jobs' },
        { kind: 'vectorize', name: 'shop-search' },
        { kind: 'hyperdrive', id: 'hd-1' },
        { kind: 'other', type: 'pipelines', name: 'clicks' },
      ],
    ],
    [
      'other-site',
      [
        { kind: 'r2', bucket: 'shared-files' },
        { kind: 'queue', name: 'events' },
      ],
    ],
    ['cloudchef-workspace-1', [{ kind: 'd1', id: 'db-runtime' }]],
  ]);
  const record = (call: string) => {
    calls.push(call);
    if (options.failOn === call) {
      throw new Error('Cloudflare API request failed (500).');
    }
  };
  const api: ProjectDeletionApi = {
    listWorkerScripts: async () => [
      { tag: 'a'.repeat(32), name: 'storefront' },
      { tag: 'b'.repeat(32), name: 'other-site' },
      { tag: 'c'.repeat(32), name: 'cloudchef-workspace-1' },
    ],
    latestWorkersBuilds: async () => new Map(),
    listWorkersBuildTriggers: async (tag) =>
      tag === 'a'.repeat(32)
        ? ['trigger-main', 'trigger-previews'].map((id) => ({
            id,
            name: null,
            buildCommand: null,
            deployCommand: null,
            rootDirectory: null,
            branchIncludes: [],
            branchExcludes: [],
            repository: null,
          }))
        : [],
    deleteWorkersBuildTrigger: async (id) => record(`trigger ${id}`),
    workerBindings: async (name) => bindings.get(name) ?? null,
    d1DatabaseName: async (id) => (id === 'db-1' ? 'shop-data' : null),
    kvNamespaceTitle: async (id) => (id === 'kv-1' ? 'shop-cache' : null),
    deleteManagedWorker: async (name) => record(`worker ${name}`),
    deleteD1DatabaseById: async (id) => record(`d1 ${id}`),
    deleteKvNamespaceById: async (id) => record(`kv ${id}`),
    deleteR2Bucket: async (name) => {
      record(`r2 ${name}`);
      return true;
    },
    listQueues: async () => [
      { id: 'queue-orders', name: 'orders', workers: ['storefront'] },
      { id: 'queue-events', name: 'events', workers: ['storefront', 'other-site'] },
      // Read by another Worker, which doesn't bind it.
      { id: 'queue-jobs', name: 'jobs', workers: ['storefront', 'worker-of-jobs'] },
    ],
    deleteQueueById: async (id) => record(`queue ${id}`),
    vectorizeIndexExists: async (name) => name === 'shop-search',
    deleteVectorizeIndex: async (name) => record(`vectorize ${name}`),
    hyperdriveConfigName: async (id) => (id === 'hd-1' ? 'shop-postgres' : null),
    deleteHyperdriveConfig: async (id) => record(`hyperdrive ${id}`),
  };
  return { api, calls };
}

async function world(options: { failOn?: string; builtBy?: 'workers_builds'; scopes?: string[] } = {}) {
  const team = await teamFixture();
  team.database.exec(`
    INSERT INTO org_projects (
      id, connection_id, org_id, name, slug, artifact_repo, created_from, deploys_with, workers_builds_script_tag,
      created_at
    )
      VALUES ('${SITE}', 'team-connection', '${ORG}', 'Storefront', 'storefront', 't-storefront', 'zip',
        '${options.builtBy ?? 'cloudchef'}', ${options.builtBy ? `'${'a'.repeat(32)}'` : 'NULL'}, 1);
    INSERT INTO project_deployments (id, project_id, kind, branch, commit_sha, state, worker_name, created_at, updated_at)
      VALUES ('d1', '${SITE}', 'production', 'main', '${'a'.repeat(40)}', 'succeeded', 'storefront', 1, 1),
             ('d2', '${SITE}', 'preview', 'idea', '${'b'.repeat(40)}', 'succeeded', 'storefront', 2, 2);
  `);
  team.database
    .prepare('UPDATE cloudflare_authorizations SET granted_oauth_scopes_json = ? WHERE account_id = ?')
    .run(JSON.stringify(options.scopes ?? [...CORE_CLOUDFLARE_OAUTH_SCOPES]), 'account-team');
  const { api, calls } = account(options);
  const repositories: string[] = [];
  const deleteRepository: DeleteProjectRepository = async ({ project }) => {
    calls.push(`repository ${project.repo}`);
    repositories.push(project.repo ?? '');
  };
  const openAccount = async () => api;
  const preview = (cookie: string) =>
    projectDeletionPreviewAction({
      request: team.browser(cookie, '/api/projects/delete/preview', { projectId: SITE }),
      env: team.env,
      openAccount,
    });
  const remove = (cookie: string, confirm: string) =>
    deleteProjectAction({
      request: team.browser(cookie, '/api/projects/delete', { projectId: SITE, confirm }),
      env: team.env,
      openAccount,
      deleteRepository,
    });
  const exists = () => team.database.prepare('SELECT id FROM org_projects WHERE id = ?').get(SITE) !== undefined;
  return { ...team, calls, repositories, preview, remove, exists };
}

const planSchema = z.object({
  workers: z.array(z.string()),
  buildTriggers: z.array(z.string()),
  resources: z.array(z.object({ kind: z.string(), name: z.string() })),
  kept: z.array(z.object({ kind: z.string(), id: z.string(), name: z.string(), reason: z.string() })),
  repository: z.string().nullable(),
});

describe('deleting a project', () => {
  it('lists its Worker and the resources only it uses, and keeps what another Worker shares', async () => {
    const { admin, preview, calls } = await world();

    const plan = planSchema.parse(await (await preview(admin.cookie)).json());

    expect(plan.workers).toEqual(['storefront']);
    expect(plan.resources.map((resource) => `${resource.kind} ${resource.name}`)).toEqual([
      'database shop-data',
      'storage shop-files',
      'keys shop-cache',
      'queue orders',
      'vectors shop-search',
      'connection shop-postgres',
    ]);
    expect(plan.kept).toEqual([
      { kind: 'storage', id: 'shared-files', name: 'shared-files', reason: 'another Worker uses it' },
      { kind: 'queue', id: 'queue-events', name: 'events', reason: 'another Worker uses it' },
      { kind: 'queue', id: 'queue-jobs', name: 'jobs', reason: 'another Worker uses it' },
      {
        kind: 'other',
        id: 'clicks',
        name: 'clicks (pipelines)',
        reason: 'CloudChef doesn’t delete this kind of resource',
      },
    ]);
    expect(plan.repository).toBe('t-storefront');
    // Reading what it would delete deletes nothing.
    expect(calls).toEqual([]);
  });

  it('deletes only once its exact name is typed: the Worker, then its resources, then its code, then its record', async () => {
    const { admin, remove, calls, exists } = await world();

    expect((await remove(admin.cookie, 'storefront')).status).toBe(400);
    expect(calls).toEqual([]);

    const answer = await remove(admin.cookie, 'Storefront');

    expect(answer.status).toBe(200);
    expect(calls).toEqual([
      'worker storefront',
      'd1 db-1',
      'r2 shop-files',
      'kv kv-1',
      'queue queue-orders',
      'vectorize shop-search',
      'hyperdrive hd-1',
      'repository t-storefront',
    ]);
    expect(exists()).toBe(false);
  });

  it('stops at a step that fails, says which, and keeps the record so deleting again finishes it', async () => {
    const { admin, remove, calls, exists } = await world({ failOn: 'r2 shop-files' });

    const answer = await remove(admin.cookie, 'Storefront');

    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({
      error: 'File storage shop-files couldn’t be deleted: Cloudflare API request failed (500).',
      deleted: ['Worker storefront', 'Database shop-data'],
    });
    expect(calls).not.toContain('repository t-storefront');
    expect(exists()).toBe(true);
  });

  it('removes the triggers Workers Builds builds it with before its Worker', async () => {
    const { admin, preview, remove, calls, exists } = await world({ builtBy: 'workers_builds' });

    const plan = planSchema.parse(await (await preview(admin.cookie)).json());
    expect(plan.workers).toEqual(['storefront']);
    expect(plan.buildTriggers).toEqual(['trigger-main', 'trigger-previews']);

    const answer = await remove(admin.cookie, 'Storefront');

    expect(answer.status).toBe(200);
    expect(calls.slice(0, 3)).toEqual(['trigger trigger-main', 'trigger trigger-previews', 'worker storefront']);
    expect(z.object({ deleted: z.array(z.string()) }).parse(await answer.json()).deleted[0]).toBe(
      'Automatic builds of storefront',
    );
    expect(exists()).toBe(false);
  });

  it.each(['workers-ci.write', 'queues.write', 'vectorize.write', 'query-cache.write'])(
    'asks a connection authorized before CloudChef asked for %s to reauthorize, and reads or deletes nothing',
    async (scope) => {
      const { admin, preview, remove, calls, exists } = await world({
        builtBy: 'workers_builds',
        scopes: CORE_CLOUDFLARE_OAUTH_SCOPES.filter((granted) => granted !== scope),
      });
      const code = z.object({ code: z.string() });

      const previewed = await preview(admin.cookie);
      expect(previewed.status).toBe(409);
      expect(code.parse(await previewed.json()).code).toBe('cloudflare_reauthorization_required');
      const answer = await remove(admin.cookie, 'Storefront');
      expect(answer.status).toBe(409);
      expect(code.parse(await answer.json()).code).toBe('cloudflare_reauthorization_required');
      expect(calls).toEqual([]);
      expect(exists()).toBe(true);
    },
  );

  it('is refused to a team member who doesn’t manage it, in the browser and from their runtime', async () => {
    const { sara, admin, preview, remove, calls, exists, runtime, env } = await world();

    expect((await preview(sara.cookie)).status).toBe(404);
    expect((await remove(sara.cookie, 'Storefront')).status).toBe(404);
    expect(calls).toEqual([]);
    expect(exists()).toBe(true);

    const asked = (userId: string) =>
      runtime('/api/cloudflare/runtime-projects/deletable', { orgProjectId: SITE }, { userId }).then((request) =>
        runtimeDeletableProjectAction({ request, env }),
      );
    expect((await asked(sara.userId)).status).toBe(403);
    const allowed = await asked(admin.userId);
    expect(await allowed.json()).toEqual({ repo: 't-storefront' });
  });
});
