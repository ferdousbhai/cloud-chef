import { generateTitle, type TitleSubject } from '~/lib/title-generation';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';
import { getPiModel } from './pi-ai-models';
import type { WorkersAiAccountCredentials } from './pi-ai-models';
import type { WorkersAiGatewayLogging } from './workers-ai-gateway';
import { completeText } from './pi-ai-invoke';
import type { Usage } from '@earendil-works/pi-ai';

export function generateProjectTitle(
  prompt: string,
  accountCredentials: WorkersAiAccountCredentials,
  gatewayLogging: WorkersAiGatewayLogging,
  onUsage?: (usage: Usage) => void,
): Promise<string | null> {
  return generateModelTitle(prompt, 'project', accountCredentials, gatewayLogging, onUsage);
}

export function generateConversationTitle(
  prompt: string,
  accountCredentials: WorkersAiAccountCredentials,
  gatewayLogging: WorkersAiGatewayLogging,
  onUsage?: (usage: Usage) => void,
): Promise<string | null> {
  return generateModelTitle(prompt, 'conversation', accountCredentials, gatewayLogging, onUsage);
}

/**
 * Resolves to `null` only when there is nothing to name or the model named it badly. A model that
 * answered with no text at all rejects with `EmptyTitleReplyError` instead, so the builder's title
 * fiber reports it on its existing warn path rather than leaving the heuristic title in place with
 * no trace of why.
 */
async function generateModelTitle(
  prompt: string,
  subject: TitleSubject,
  accountCredentials: WorkersAiAccountCredentials,
  gatewayLogging: WorkersAiGatewayLogging,
  onUsage?: (usage: Usage) => void,
): Promise<string | null> {
  const handle = getPiModel(accountCredentials, CLOUDFLARE_PROJECT_TITLE_MODEL, { gatewayLogging });
  const generated = await generateTitle({
    execute: async (request) => ({
      text: await completeText(handle, {
        prompt: request.prompt,
        maxTokens: request.maxOutputTokens,
        temperature: request.temperature,
        onUsage,
      }),
    }),
    prompt,
    subject,
  });
  return generated?.title ?? null;
}
