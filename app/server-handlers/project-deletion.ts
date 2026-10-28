import { z } from 'zod';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { openConnectionAccountApi } from '~/lib/.server/cloudflare/connection-account-api';
import {
  deleteProjectResources,
  planProjectDeletion,
  type ProjectDeletionApi,
} from '~/lib/.server/cloudflare/project-deletion';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import { publicOrigin } from '~/lib/.server/public-origin';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { deleteProjectRecord, requireManagedProject, type Project } from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import { projectWorkerNames } from '~/lib/cloudflare/data/project-deployments.server';
import { runtimeFor } from './command-line';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';
import { json } from './runtime-projects';
import { signedIn } from './signed-in';

type OpenDeletionAccountApi = (
  env: Env,
  connection: Pick<CloudflareConnection, 'accountId' | 'credentialHandle'>,
) => Promise<ProjectDeletionApi>;

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

/** The project, if this person manages it, and what deleting it would remove from its account now. */
async function readPlan(env: Env, userId: string, projectId: string, openAccount: OpenDeletionAccountApi) {
  const project = await requireManagedProject(env.DB, userId, projectId);
  const connection = await findActiveCloudflareConnection(env.DB, project.connectionId);
  if (!connection) {
    throw new OrganizationError('Connect the Cloudflare account first.', 409);
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
      const { project, plan } = await readPlan(env, session.user.id, body.data.projectId, openAccount);
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
 * again here, never taken from the browser. Its Workers go first, then the databases and storage only they used,
 * then its code, then CloudChef's record; a step that fails stops it there and the record stays, so deleting again
 * finishes the job.
 */
export function deleteProjectAction({
  request,
  env,
  openAccount = openConnectionAccountApi,
  deleteRepository = deleteRepositoryThroughRuntime,
}: {
  request: Request;
  env: Env;
  openAccount?: OpenDeletionAccountApi;
  deleteRepository?: DeleteProjectRepository;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, deleteSchema, 'Choose a project.');
    if ('response' in body) {
      return body.response;
    }
    try {
      const { project, api, plan } = await readPlan(env, session.user.id, body.data.projectId, openAccount);
      if (body.data.confirm !== project.name) {
        return Response.json({ error: `Type ${project.name} to confirm.` }, { status: 400 });
      }
      const result = await deleteProjectResources(api, plan, () =>
        deleteRepository({ request, env, userId: session.user.id, project }),
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
