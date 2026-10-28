import { getUserRuntimeSession } from '~/lib/cloudflare/runtime-session';

export const CONVERSATION_AGENT_QUERY_CACHE_TTL_MS = 0;

export async function loadConversationAgentCapability(): Promise<{ capability: string }> {
  return { capability: (await getUserRuntimeSession()).token };
}
