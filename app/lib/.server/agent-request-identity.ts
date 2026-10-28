import { routeAgentRequest } from 'agents';
import { ensureInitialChat } from '~/lib/cloudflare/data/chat-repository.server';

const MAX_CONVERSATION_AGENT_NAME_LENGTH = 512;
const CANONICAL_ROOT_AGENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type AgentRequestRoute =
  { kind: 'not-agent' } | { kind: 'rejected' } | { kind: 'conversation-agent'; canonicalName: string };

function resolveAgentRequestRoute(pathname: string): AgentRequestRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'agents') {
    return { kind: 'not-agent' };
  }
  // `builder-agent` is the class's name before it was renamed, which browsers use until every runtime has the new one.
  if (segments.length < 3 || (segments[1] !== 'conversation-agent' && segments[1] !== 'builder-agent')) {
    return { kind: 'rejected' };
  }

  const encodedName = segments[2];
  try {
    const decodedName = decodeURIComponent(encodedName);
    if (
      !decodedName ||
      decodedName.length > MAX_CONVERSATION_AGENT_NAME_LENGTH ||
      encodedName.length > MAX_CONVERSATION_AGENT_NAME_LENGTH ||
      encodeURIComponent(decodedName) !== encodedName
    ) {
      return { kind: 'rejected' };
    }
  } catch {
    return { kind: 'rejected' };
  }
  // PartyServer addresses the Durable Object with the encoded path segment.
  // Keep that exact canonical wire name as the sole authorization and routing identity.
  return { kind: 'conversation-agent', canonicalName: encodedName };
}

export async function routeUserRuntimeAgentRequest(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response | null> {
  const route = resolveAgentRequestRoute(new URL(request.url).pathname);
  if (route.kind === 'not-agent') {
    return null;
  }
  if (route.kind === 'rejected') {
    return agentNotFoundResponse();
  }
  const denial = await authorizeAgentForUser(env, route.canonicalName, userId);
  if (denial) {
    return denial;
  }
  const url = new URL(request.url);
  const renamed = url.pathname.replace(/^\/agents\/builder-agent\//, '/agents/conversation-agent/');
  const routed = renamed === url.pathname ? request : new Request(new URL(renamed + url.search, url), request);
  return (await routeAgentRequest(routed, env, { props: { userId } })) ?? agentNotFoundResponse();
}

// Resolves to the denial response, or null when the user is authorized for the agent.
async function authorizeAgentForUser(env: Env, agentName: string, userId: string): Promise<Response | null> {
  const chat = await env.DB.prepare(
    `SELECT COUNT(*) AS match_count,
            SUM(CASE WHEN workspaces.is_deleted = 0 THEN 1 ELSE 0 END) AS active_match_count,
            MAX(CASE WHEN workspaces.creator_id <> ? THEN 1 ELSE 0 END) AS has_owner_conflict
     FROM workspaces
     LEFT JOIN conversations ON conversations.workspace_id = workspaces.id
     WHERE workspaces.initial_id = ? OR conversations.agent_name = ?`,
  )
    .bind(userId, agentName, agentName)
    .first<{ match_count: number; active_match_count: number; has_owner_conflict: number | null }>();
  if (!chat || chat.match_count === 0) {
    if (!CANONICAL_ROOT_AGENT_NAME.test(agentName)) {
      return agentNotFoundResponse();
    }
    try {
      await ensureInitialChat(env.DB, {
        id: crypto.randomUUID(),
        creatorId: userId,
        initialId: agentName,
      });
    } catch (error) {
      const activeOwner = await env.DB.prepare(
        `SELECT workspaces.creator_id
         FROM workspaces
         LEFT JOIN conversations ON conversations.workspace_id = workspaces.id
         WHERE (workspaces.initial_id = ? OR conversations.agent_name = ?) AND workspaces.is_deleted = 0
         LIMIT 1`,
      )
        .bind(agentName, agentName)
        .first<{ creator_id: string }>();
      if (!activeOwner) {
        throw error;
      }
      if (activeOwner.creator_id !== userId) {
        return Response.json({ error: 'Agent not found.' }, { status: 404 });
      }
    }
    return null;
  }
  if (chat.active_match_count === 0 || chat.has_owner_conflict !== 0) {
    return Response.json({ error: 'Agent not found.' }, { status: 404 });
  }
  return null;
}

function agentNotFoundResponse(): Response {
  return Response.json({ error: 'Agent not found.' }, { status: 404 });
}
