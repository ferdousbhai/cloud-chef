import { findReadableProject } from '~/lib/cloudflare/data/org-projects.server';
import {
  isSharedOp,
  sharedOpWrites,
  sharedWorkspaceName,
  SHARED_WORKSPACE_HEADER,
} from '~/lib/.server/cloudflare/shared-project';
import { forwardToProjectAccount } from './command-line';
import { authenticateRuntimeRequest } from './runtime-authentication';

/**
 * `/api/cloudflare/runtime-shared/<project>/<op>`: a workspace runtime reading a project its own repositories don't
 * give it (`app/lib/.server/cloudflare/shared-project.ts`): one in another Cloudflare account, or one of its own
 * account its person may only view. The runtime proves who it is, as every runtime route does; then, on every
 * request, the person must still be able to read the project. The request goes on to a runtime in the project's
 * account, which answers it. Nothing is pushed this way: someone who may change a project works in its account, where
 * their runtime pushes to it itself.
 *
 * A public project's reads, and git's fetches of it, are answered for anyone signed in, as its code is readable by
 * anyone at its git address: a read-only `@cloudchef` run seeds its workspace from them, and the agent fetches a
 * public copy a thread suggests a change from (docs/proposals/comment-threads.md).
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
  if ((request.method === 'POST') !== op.startsWith('git/git-')) {
    return refusal('Method not allowed.', 405);
  }
  const authenticated = await authenticateRuntimeRequest(env, request);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { identity } = authenticated;
  // Reads and fetches of any project they may read, in any account, their own included (one they may only view, or a
  // public copy beside the original). Never a push.
  const project = sharedOpWrites(op, url.searchParams)
    ? null
    : await findReadableProject(env.DB, { id: match[1]! }, identity.userId);
  if (!project) {
    return refusal('This project is not shared with you.', 403);
  }
  const workspace = sharedWorkspaceName(request.headers.get(SHARED_WORKSPACE_HEADER));
  if (!workspace) {
    return refusal('Name the workspace this is for.', 400);
  }
  try {
    return await forwardToProjectAccount(request, env, {
      project,
      userId: identity.userId,
      role: 'view',
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
