import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { piAgentRunner } from '~/lib/.server/llm/pi-agent-runner';
import { createPiStreamResponse } from './llm/pi-stream';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { ModelInputBudgetExceededError } from './llm/model-input';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import type { WorkersAiAccountCredentials } from './llm/pi-ai-models';
import type { ContextCompaction } from './llm/context-compaction';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { logProviderFailure } from './llm/provider-error-logging';
import type { WorkersAiModel, WorkersAiModelId } from '~/lib/workers-ai-model';
import type { PiSteeringQueue } from './llm/pi-steering';
import type { BuilderTurnBudgetReport } from './llm/builder-turn-budget';
import type { CloudflareMcpModelToolContext } from './llm/cloudflare-mcp-model-tools';

type Messages = CloudChefMessage[];

const logger = createScopedLogger('api.chat');

export type ChatRequestBody = {
  messages?: Messages;
  modelId: WorkersAiModelId;
};

export async function createChatResponseFromBody({
  abortSignal,
  body,
  model,
  compaction,
  firstUserMessage,
  turnContext,
  accountCredentials,
  sessionAffinity,
  workspace,
  cloudflareMcp,
  onValidationStage,
  runWithKeepAlive,
  steering,
  onSettled,
}: {
  abortSignal?: AbortSignal;
  body: ChatRequestBody;
  model: WorkersAiModel;
  compaction: {
    current: ContextCompaction | null;
    pending: boolean;
    save: (compaction: ContextCompaction) => void;
    schedule?: () => Promise<void>;
    requestDurableCompaction?: () => void;
  };
  firstUserMessage: boolean;
  turnContext?: ChatTurnContext;
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  workspace: BuilderWorkspaceApi;
  cloudflareMcp?: CloudflareMcpModelToolContext;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  steering: PiSteeringQueue;
  onSettled: (budget: BuilderTurnBudgetReport) => void;
}) {
  const { messages, modelId } = body;
  const transcriptMessages = messages ?? [];
  if (model.id !== modelId) {
    throw new Response('The selected Workers AI model changed while the request was being prepared.', { status: 409 });
  }

  logger.info('Using Cloudflare AI');

  try {
    const dataStream = await piAgentRunner({
      abortSignal,
      firstUserMessage,
      messages: transcriptMessages,
      model,
      turnContext,
      compaction,
      accountCredentials,
      sessionAffinity,
      workspace,
      cloudflareMcp,
      onValidationStage,
      runWithKeepAlive,
      steering,
      onSettled,
    });

    return createPiStreamResponse(dataStream);
  } catch (error: unknown) {
    logProviderFailure(logger, 'Workers AI chat request failed', error);

    if (error instanceof ModelInputBudgetExceededError) {
      throw new Response(error.message, {
        status: 413,
        statusText: 'Current request is too large',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
