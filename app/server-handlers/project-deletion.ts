import { z } from 'zod';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { openConnectionAccountApi } from '~/lib/.server/cloudflare/connection-account-api';
import {
  deleteProjectResources,
  planProjectDeletion,
  type ProjectDeletionApi,
} from '~/lib/.server/cloudflare/project-deletion';
import { missingCoreOAuthScopes } from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import { publicOrigin } from '~/lib/.server/public-origin';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { deleteProjectRecord, requireManagedProject, type Project } from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import { projectWorkerNames } from '~/lib/cloudflare/data/project-deployments.server';
import { cloudflareReauthorizationRequired } from './cloudflare-integration';
import { runtimeFor } from './command-line';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';
import { json } from './runtime-projects';
import { signedIn } from './signed-in';

type OpenDeletionAccountApi = (
  env: Env,
  connection: Pick<CloudflareConnection, 'accountId' | 'credentialHandle'>,
) => Promise<ProjectDeletionApi>;

/**
 * Removes every workspace of a project from the runtimes of the people who work in its account, so none is left
 * that can't open a project that no longer exists.
 */
export type RemoveProjectWorkspaces = (args: { request: Request; env: Env; project: Project }) => Promise<void>;

/** Deletes a project's repository in its account: through the deleting person's runtime, which holds Artifacts. */
export type DeleteProjectRepository = (args: {
  request: Request;
  env: Env;
  userId: string;
  project: Project;
}) => Promise<void>;

const previewSchema = z.strictObject({ projectId: z.string().uuid() });
const deleteSchema = z.strictObject({ projectId: z.string().uuid(), confirm: z.string().max(200) });

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * The project, if this person manages it, and what deleting it would remove from its account now. A connection
 * authorized before CloudChef asked for a permission deleting uses (its builds, queues, search indexes, database
 * connections) is asked to reauthorize first.
 */
async function readPlan(env: Env, userId: string, projectId: string, openAccount: OpenDeletionAccountApi) {
  const project = await requireManagedProject(env.DB, userId, projectId);
  const connection = await findActiveCloudflareConnection(env.DB, project.connectionId);
  if (!connection) {
    throw new OrganizationError('Connect the Cloudflare account first.', 409);
  }
  if (missingCoreOAuthScopes(connection.grantedOAuthScopes).length > 0) {
    return cloudflareReauthorizationRequired();
  }
  const api = await openAccount(env, connection);
  const plan = await planProjectDeletion(api, project, await projectWorkerNames(env.DB, project.id));
  return { project, api, plan };
}

function accountUnreadable(error: CloudflareAccountApiError): Response {
  return Response.json({ error: `The Cloudflare account couldn’t be read: ${error.message}` }, { status: 502 });
}

/** `POST /api/projects/delete/preview`: what deleting a project would remove, and what it would keep. */
export function projectDeletionPreviewAction({
  request,
  env,
  openAccount = openConnectionAccountApi,
}: {
  request: Request;
  env: Env;
  openAccount?: OpenDeletionAccountApi;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, previewSchema, 'Choose a project.');
    if ('response' in body) {
      return body.response;
    }
    try {
      const read = await readPlan(env, session.user.id, body.data.projectId, openAccount);
      if (read instanceof Response) {
        return read;
      }
      const { project, plan } = read;
      return Response.json({ name: project.name, ...plan }, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CloudflareAccountApiError) {
        return accountUnreadable(error);
      }
      throw error;
    }
  });
}

/**
 * `POST /api/projects/delete`: deletes a project for good, with `confirm` its exact name. What it removes is read
 * again here, never taken from the browser. Its builds triggers and Workers go first, then the databases and storage only they used,
 * then its code, then every member's workspace of it, then CloudChef's record; a step that fails stops it there and the record stays, so deleting again
 * finishes the job.
 */
export function deleteProjectAction({
  request,
  env,
  openAccount = openConnectionAccountApi,
  deleteRepository = deleteRepositoryThroughRuntime,
  removeWorkspaces = removeWorkspacesThroughRuntimes,
}: {
  request: Request;
  env: Env;
  openAccount?: OpenDeletionAccountApi;
  deleteRepository?: DeleteProjectRepository;
  removeWorkspaces?: RemoveProjectWorkspaces;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, deleteSchema, 'Choose a project.');
    if ('response' in body) {
      return body.response;
    }
    try {
      const read = await readPlan(env, session.user.id, body.data.projectId, openAccount);
      if (read instanceof Response) {
        return read;
      }
      const { project, api, plan } = read;
      if (body.data.confirm !== project.name) {
        return Response.json({ error: `Type ${project.name} to confirm.` }, { status: 400 });
      }
      const result = await deleteProjectResources(
        api,
        plan,
        () => deleteRepository({ request, env, userId: session.user.id, project }),
        () => removeWorkspaces({ request, env, project }),
      );
      if (result.failed) {
        return Response.json(
          {
            error: `${result.failed.step} couldn’t be deleted: ${result.failed.reason}`,
            deleted: result.deleted,
          },
          { status: 502, headers: NO_STORE },
        );
      }
      await deleteProjectRecord(env.DB, project.id);
      return Response.json({ deleted: result.deleted }, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CloudflareAccountApiError) {
        return accountUnreadable(error);
      }
      throw error;
    }
  });
}

/** Asks the deleting person's runtime in the project's account to delete its repository. */
const deleteRepositoryThroughRuntime: DeleteProjectRepository = async ({ request, env, userId, project }) => {
  const runtime = await runtimeFor(request, env, userId, project.connectionId);
  if ('refusal' in runtime) {
    throw new Error(runtime.refusal);
  }
  const answer = await fetch(new URL('/v1/projects/delete-repository', runtime.endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.token}`,
      origin: publicOrigin(request),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ orgProjectId: project.id }),
  });
  if (!answer.ok) {
    const refusal = z.object({ error: z.string() }).safeParse(await answer.json().catch(() => null));
    throw new Error(refusal.data?.error ?? 'Try again.');
  }
  await answer.body?.cancel();
};

/**
 * Asks the runtime of each person with one in the project's account to remove their workspace of it. Someone who
 * may no longer use the account, or whose runtime isn't ready, is skipped: that runtime removes its workspace of the
 * project itself on its next maintenance sweep once the project's record is gone (`sweepDeletedProjectWorkspaces`),
 * and until then opening it says the project was deleted. A runtime that is ready and refuses stops the deletion,
 * which deleting again finishes.
 */
const removeWorkspacesThroughRuntimes: RemoveProjectWorkspaces = async ({ request, env, project }) => {
  const { results } = await env.DB.prepare(
    `SELECT user_id FROM user_computer_runtimes WHERE connection_id = ? AND status = 'ready' ORDER BY user_id`,
  )
    .bind(project.connectionId)
    .all<{ user_id: string }>();
  for (const { user_id: userId } of results) {
    const runtime = await runtimeFor(request, env, userId, project.connectionId);
    if ('refusal' in runtime) {
      continue;
    }
    const answer = await fetch(new URL('/v1/projects/remove-workspace', runtime.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        origin: publicOrigin(request),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ orgProjectId: project.id }),
    });
    if (!answer.ok) {
      const refusal = z.object({ error: z.string() }).safeParse(await answer.json().catch(() => null));
      throw new Error(refusal.data?.error ?? 'A workspace couldn’t be reached. Try again.');
    }
    await answer.body?.cancel();
  }
};

const deletableSchema = z.object({ orgProjectId: z.string().uuid() }).strict();

/**
 * A runtime asking, before it deletes a project's repository, whether its person may delete the project (its owner,
 * or one of its team's admins) in the account the runtime is in: answers the repository, or null when it has none.
 */
export async function runtimeDeletableProjectAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, deletableSchema, {
    maxBytes: 1024,
    label: 'Workspace runtime project deletion',
    invalid: 'Invalid project deletion request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  try {
    const project = await requireManagedProject(
      args.env.DB,
      authenticated.identity.userId,
      authenticated.body.orgProjectId,
    );
    if (project.connectionId !== authenticated.connection.id) {
      return json({ error: 'That project isn’t in this account.' }, 403);
    }
    return json({ repo: project.repo }, 200);
  } catch (error) {
    if (error instanceof OrganizationError) {
      return json({ error: 'Only the project’s owner, or one of its team’s admins, can delete it.' }, 403);
    }
    throw error;
  }
}
