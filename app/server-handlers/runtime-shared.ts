import { findAccessibleProject, findReadableProject } from '~/lib/cloudflare/data/org-projects.server';
import {
  isSharedOp,
  isSharedRead,
  sharedOpWrites,
  sharedWorkspaceName,
  SHARED_WORKSPACE_HEADER,
} from '~/lib/.server/cloudflare/shared-project';
import { forwardToProjectAccount } from './command-line';
import { authenticateRuntimeRequest } from './runtime-authentication';

/**
 * `/api/cloudflare/runtime-shared/<project>/<op>`: a workspace runtime reading or pushing a project shared with its
 * person from another Cloudflare account (`app/lib/.server/cloudflare/shared-project.ts`). The runtime proves who it
 * is, as every runtime route does; then, on every request, the person must still have the project shared with them
 * (a view to read, an edit to push), so removing them, or making them a viewer, stops their workspace at its next
 * request. The request goes on to a runtime in the project's account, which answers it.
 *
 * A public project's reads, and git's fetches of it (never a push), are answered for anyone signed in, as its code is
 * readable by anyone at its git address: a read-only `@cloudchef` run seeds its workspace from them, and the agent
 * fetches a public copy a thread suggests a change from (docs/proposals/comment-threads.md).
 */
const SHARED_PATH =
  /^\/api\/cloudflare\/runtime-shared\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/;

export function isRuntimeSharedPath(pathname: string): boolean {
  return SHARED_PATH.test(pathname);
}

export async function runtimeSharedAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const url = new URL(request.url);
  const match = SHARED_PATH.exec(url.pathname);
  const op = match?.[2] ?? '';
  if (!match || !isSharedOp(op)) {
    return refusal('Not found.', 404);
  }
  const write = sharedOpWrites(op, url.searchParams);
  if ((request.method === 'POST') !== op.startsWith('git/git-')) {
    return refusal('Method not allowed.', 405);
  }
  const authenticated = await authenticateRuntimeRequest(env, request);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { identity, connection } = authenticated;
  const readable =
    isSharedRead(op) || !write ? await findReadableProject(env.DB, { id: match[1]! }, identity.userId) : null;
  const project = readable ?? (await findAccessibleProject(env.DB, match[1]!, identity.userId));
  // Reads and fetches: any project they may read, in any account, their own included (a team project they may only
  // view, or a public copy beside the original). A push: only one shared with them from another account, since a
  // runtime pushes to a project of its own account itself.
  if (!project || (!readable && (project.connectionId === connection.id || !project.shared))) {
    return refusal('This project is not shared with you.', 403);
  }
  // With the view role a push goes on too: the runtime in the project's account lets it set only their workspace's
  // saved branches, where their commits are kept, from the role signed here.
  const role = project.role === 'edit' ? 'edit' : 'view';
  const workspace = sharedWorkspaceName(request.headers.get(SHARED_WORKSPACE_HEADER));
  if (!workspace) {
    return refusal('Name the workspace this is for.', 400);
  }
  try {
    return await forwardToProjectAccount(request, env, {
      project,
      userId: identity.userId,
      role,
      op,
      workspace,
    });
  } catch {
    console.error('A shared project request could not be sent on');
    return refusal('This project can’t be reached just now. Try again.', 502);
  }
}

function refusal(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}
