import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { reelRequestSchema, type ReelRequest } from '../../app/agents/builder-reels';
import type { ConversationAgent } from '../../app/agents/conversation-agent';
import { REEL_PROXY_HOST, REEL_REQUEST_MAX_BYTES } from '../../app/lib/reel';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '../../app/lib/bounded-body';
import type { ProjectWorkspace } from './index';

type ReelProxyEnv = {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
  ConversationAgent: DurableObjectNamespace<ConversationAgent>;
};

/**
 * Minted for one workspace by its ProjectWorkspace, as the handler for `showcase.internal` in its container: the
 * `cloudchef reel` command's clip goes to the agent whose command is running, which makes it and shows it in the chat
 * for the person to approve. With no agent command running (the person's own terminal), nothing is made: clips are
 * the agent's, shown in its chat.
 */
export class ReelProxy extends WorkerEntrypoint<ReelProxyEnv, { workspaceId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== REEL_PROXY_HOST || url.pathname !== '/reel') {
      return text(404, 'Not found.');
    }
    if (request.method !== 'POST') {
      return text(405, 'Send the clip with POST.');
    }
    const namespace = this.env.PROJECT_WORKSPACE;
    const workspace = namespace.get(namespace.idFromString(this.ctx.props.workspaceId));
    const command = await workspace.runningAgentCommand();
    if (!command) {
      return text(409, 'A clip is made by the agent, in the chat: ask it there.');
    }
    let body: ReelRequest;
    try {
      body = reelRequestSchema.parse(await readJsonBodyWithLimit(request, REEL_REQUEST_MAX_BYTES, 'Clip'));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return text(413, 'The clip is too large: use fewer or smaller pictures (WebP).');
      }
      if (error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
        return text(400, 'The clip could not be read.');
      }
      throw error;
    }
    const answer = await this.env.ConversationAgent.getByName(command.agentName).proposeReel({
      toolCallId: command.toolCallId,
      request: body,
    });
    return text(answer.status, answer.message);
  }
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
