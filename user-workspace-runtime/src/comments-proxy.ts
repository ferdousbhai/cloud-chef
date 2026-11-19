import { z } from 'zod';
import type { ConversationAgent } from '../../app/agents/conversation-agent';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '../../app/lib/bounded-body';
import {
  runtimeConnectionIdentity,
  type RuntimeConnectionEnv,
} from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { runCommentsRequest, runSuggestRequest } from '../../app/lib/.server/cloudflare/thread-comments-client';
import { parseCommentsArguments, suggestCommandSchema } from '../../app/lib/thread-comments';
import type { ProjectWorkspace } from './index';

export type CommentsProxyEnv = RuntimeConnectionEnv &
  Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'> & {
    PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
    ConversationAgent: DurableObjectNamespace<ConversationAgent>;
  };

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_SUGGEST_BYTES = 32 * 1024;
const requestSchema = z.strictObject({ args: z.array(z.string().max(64)).max(8) });

/**
 * `cloudchef comments` in a workspace container, at `showcase.internal/comments` (docs/proposals/comment-threads.md).
 * While an agent command runs, its conversation answers: it knows the project, or the post a read-only chat reads,
 * and whether a mention in a thread started its turn, which closing needs. From the person's own terminal the
 * threads of the workspace's project are read; closing is the agent's, answering a mention.
 */
export async function answerCommentsCommand(
  request: Request,
  env: CommentsProxyEnv,
  workspaceId: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return text(405, 'Send the command with POST.');
  }
  let args: string[];
  try {
    args = requestSchema.parse(await readJsonBodyWithLimit(request, MAX_REQUEST_BYTES, 'Comments command')).args;
  } catch (error) {
    if (error instanceof PayloadTooLargeError || error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return text(400, 'The command could not be read.');
    }
    throw error;
  }
  const command = parseCommentsArguments(args);
  if ('usage' in command) {
    return text(400, command.usage);
  }
  const workspace = env.PROJECT_WORKSPACE.get(env.PROJECT_WORKSPACE.idFromString(workspaceId));
  const running = await workspace.runningAgentCommand();
  if (running) {
    const answer = await env.ConversationAgent.getByName(running.agentName).answerComments({
      toolCallId: running.toolCallId,
      command,
    });
    return text(answer.status, answer.message);
  }
  if (command.op === 'close') {
    return text(
      409,
      'Threads are closed on the post’s page, or by CloudChef in a chat a @cloudchef mention in that thread started.',
    );
  }
  const linked = await workspace.linkedProject();
  const identity = runtimeConnectionIdentity(env);
  if (!linked || !identity) {
    return text(409, 'This workspace isn’t a project’s, so it has no comment threads to read here.');
  }
  const output = await runCommentsRequest(env, identity, { ...command, orgProjectId: linked.orgProjectId });
  return text(output.ok ? 200 : 400, output.text.trimEnd());
}

/**
 * `cloudchef suggest` in a workspace container, at `showcase.internal/suggest`: the commit the command kept in the
 * project's repository is offered, as the workspace's person, to the people who can change its project. From the
 * agent's command or the person's own terminal alike: the offer is theirs either way.
 */
export async function answerSuggestCommand(
  request: Request,
  env: CommentsProxyEnv,
  workspaceId: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return text(405, 'Send the command with POST.');
  }
  const command = suggestCommandSchema.safeParse(
    await readJsonBodyWithLimit(request, MAX_SUGGEST_BYTES, 'Suggestion').catch(() => null),
  );
  if (!command.success) {
    return text(400, 'Usage: cloudchef suggest "<what the change does, for the people who make the project>"');
  }
  const workspace = env.PROJECT_WORKSPACE.get(env.PROJECT_WORKSPACE.idFromString(workspaceId));
  const linked = await workspace.linkedProject();
  const identity = runtimeConnectionIdentity(env);
  if (!linked || !identity) {
    return text(409, 'This workspace isn’t a project’s, so there is nobody to offer a change to.');
  }
  const output = await runSuggestRequest(env, identity, { ...command.data, orgProjectId: linked.orgProjectId });
  return text(output.ok ? 200 : 400, output.text.trimEnd());
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
