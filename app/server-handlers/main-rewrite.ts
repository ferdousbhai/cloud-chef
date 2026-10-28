import { z } from 'zod';
import { MAIN_REWRITE_OWNER_ONLY } from '~/lib/.server/cloudflare/linked-project-client';
import { publicOrigin } from '~/lib/.server/public-origin';
import { readJsonRequest } from '~/lib/.server/request-guards';
import {
  findAccessibleProject,
  recordMainRewrite,
  requireManagedProject,
  type Project,
} from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import { runtimeFor, tokenUser } from './command-line';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';
import { json } from './runtime-projects';

/**
 * Replacing a project's main with a branch's history, on purpose (`cloudchef repo rewrite-main`): a push only ever
 * adds to main, so this is how its owner, or one of its team's admins, drops what main's history holds (large files
 * in old commits). The person's runtime, which holds the account's Artifacts, moves main only from the commit the
 * person read and checks it against the control plane twice: who may do it before, and the record after.
 */

const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
/** A branch's name as git allows one, other than main itself. */
const BRANCH = z
  .string()
  .regex(/^[A-Za-z0-9._/-]{1,255}$/)
  .refine((branch) => branch !== 'main' && !branch.includes('..') && !branch.startsWith('/') && !branch.endsWith('/'));

const commandLineSchema = z.strictObject({
  project: z.string().uuid(),
  /** The branch whose history main becomes, and its commit as the person read it. */
  branch: BRANCH,
  commit: COMMIT,
  /** main's commit as the person read it: main moves only from there. */
  expected: COMMIT,
});

/**
 * `POST /api/command-line/projects/rewrite-main`: main becomes the branch's commit, even though it doesn't add to main's
 * history, through the person's runtime in the project's account. Only the project's owner, or one of its team's
 * admins; someone who may only edit it is told so.
 */
export async function commandLineRewriteMainAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Run cloudchef auth login.' }, { status: 401 });
  }
  const body = await readJsonRequest(
    request,
    commandLineSchema,
    'Name the project, a branch other than main with its commit, and main’s commit to replace.',
  );
  if ('response' in body) {
    return body.response;
  }
  let project: Project;
  try {
    project = await requireManagedProject(env.DB, userId, body.data.project);
  } catch (error) {
    if (!(error instanceof OrganizationError)) {
      throw error;
    }
    return (await findAccessibleProject(env.DB, body.data.project, userId))
      ? Response.json({ error: MAIN_REWRITE_OWNER_ONLY }, { status: 403 })
      : Response.json({ error: 'Not found.' }, { status: 404 });
  }
  const runtime = await runtimeFor(request, env, userId, project.connectionId);
  if ('refusal' in runtime) {
    return Response.json({ error: runtime.refusal }, { status: runtime.status });
  }
  const answer = await fetch(new URL('/v1/projects/rewrite-main', runtime.endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.token}`,
      origin: publicOrigin(request),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      orgProjectId: project.id,
      branch: body.data.branch,
      commit: body.data.commit,
      expected: body.data.expected,
    }),
  });
  return new Response(answer.body, {
    status: answer.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const projectSchema = z.strictObject({ orgProjectId: z.string().uuid() });
const rewrittenSchema = z.strictObject({
  orgProjectId: z.string().uuid(),
  branch: BRANCH,
  oldCommit: COMMIT,
  newCommit: COMMIT,
});

/** The project, if the runtime's person runs it (its owner, or one of its team's admins) in the runtime's account. */
async function managedProject<T extends { orgProjectId: string }>(
  args: { request: Request; env: Env },
  schema: z.ZodType<T>,
): Promise<{ project: Project; body: T; userId: string } | Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, schema, {
    maxBytes: 1024,
    label: 'Workspace runtime main rewrite',
    invalid: 'Invalid main rewrite request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const userId = authenticated.identity.userId;
  try {
    const project = await requireManagedProject(args.env.DB, userId, authenticated.body.orgProjectId);
    if (project.connectionId !== authenticated.connection.id) {
      return json({ error: 'That project isn’t in this account.' }, 403);
    }
    return { project, body: authenticated.body, userId };
  } catch (error) {
    if (error instanceof OrganizationError) {
      return json({ error: MAIN_REWRITE_OWNER_ONLY }, 403);
    }
    throw error;
  }
}

/** A runtime asking, before it replaces a project's main, whether its person may: answers the repository and who publishes it. */
export async function runtimeMainRewriteAction(args: { request: Request; env: Env }): Promise<Response> {
  const managed = await managedProject(args, projectSchema);
  if (managed instanceof Response) {
    return managed;
  }
  const { project } = managed;
  if (!project.repo) {
    return json({ error: 'This project has no code in CloudChef yet.' }, 409);
  }
  return json({ repo: project.repo, deploysWith: project.deploysWith }, 200);
}

/** A runtime reporting that its person replaced a project's main: who, when, from which branch, and from and to which commit. */
export async function runtimeMainRewrittenAction(args: { request: Request; env: Env }): Promise<Response> {
  const managed = await managedProject(args, rewrittenSchema);
  if (managed instanceof Response) {
    return managed;
  }
  const { project, body, userId } = managed;
  await recordMainRewrite(args.env.DB, {
    projectId: project.id,
    userId,
    branch: body.branch,
    oldCommit: body.oldCommit,
    newCommit: body.newCommit,
    rewrittenAt: Date.now(),
  });
  return json({ recorded: true }, 200);
}
