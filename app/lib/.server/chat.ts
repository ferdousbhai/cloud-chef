import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { piAgentRunner } from '~/lib/.server/llm/pi-agent-runner';
import { createPiStreamResponse } from './llm/pi-stream';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { ModelInputBudgetExceededError } from './llm/model-input';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import type { WorkersAiAccountCredentials } from './llm/pi-ai-models';
import type { WorkersAiGatewayLogging } from './llm/workers-ai-gateway';
import type { ContextCompaction } from './llm/context-compaction';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { logProviderFailure } from './llm/provider-error-logging';
import type { BuilderModel, BuilderModelId, BuilderReasoningLevel } from '~/lib/workers-ai-model';
import type { PiSteeringQueue } from './llm/pi-steering';
import type { BuilderTurnReport } from './llm/builder-turn-limits';
import type { CloudflareApiModelToolContext } from './llm/cloudflare-api-model-tools';
import type { LinkedProjectModelToolContext } from './llm/linked-project-model-tools';
import type { ModelTurnUsage } from './llm/workers-ai-telemetry';

type Messages = CloudChefMessage[];

const logger = createScopedLogger('api.chat');

export type ChatRequestBody = {
  messages?: Messages;
  modelId: BuilderModelId;
};

export async function createChatResponseFromBody({
  abortSignal,
  body,
  model,
  reasoningLevel,
  compaction,
  firstUserMessage,
  turnContext,
  accountCredentials,
  sessionAffinity,
  gatewayLogging,
  gatewayKeyAlias,
  workspace,
  cloudflareApi,
  linkedProject,
  onValidationStage,
  runWithKeepAlive,
  steering,
  onSettled,
  onModelUsage,
}: {
  abortSignal?: AbortSignal;
  body: ChatRequestBody;
  model: BuilderModel;
  /** The reasoning effort the person chose for this model; absent for the provider's default. */
  reasoningLevel?: BuilderReasoningLevel;
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
  gatewayLogging?: WorkersAiGatewayLogging;
  /** For a gateway provider's model: the alias of the account's key for that provider. */
  gatewayKeyAlias?: string;
  workspace: BuilderWorkspaceApi;
  cloudflareApi?: CloudflareApiModelToolContext;
  linkedProject?: LinkedProjectModelToolContext;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  steering: PiSteeringQueue;
  onSettled: (report: BuilderTurnReport) => void;
  onModelUsage?: (usage: ModelTurnUsage) => void;
}) {
  const { messages, modelId } = body;
  const transcriptMessages = messages ?? [];
  if (model.id !== modelId) {
    throw new Response('The selected model changed while the request was being prepared.', { status: 409 });
  }

  logger.info('Using Cloudflare AI');

  try {
    const dataStream = await piAgentRunner({
      abortSignal,
      firstUserMessage,
      messages: transcriptMessages,
      model,
      reasoningLevel,
      turnContext,
      compaction,
      accountCredentials,
      sessionAffinity,
      gatewayLogging,
      gatewayKeyAlias,
      workspace,
      cloudflareApi,
      linkedProject,
      onValidationStage,
      runWithKeepAlive,
      steering,
      onSettled,
      onModelUsage,
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
