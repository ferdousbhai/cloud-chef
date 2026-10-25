import type { Usage } from '@earendil-works/pi-ai';
import {
  confirmUserWorkspaceAccess,
  modelRequestAccess,
  type ConfirmUserWorkspaceAccess,
} from '~/lib/.server/cloudflare/user-workspace-cloudflare-credential';
import { workersAiGatewayLogging } from '~/lib/.server/llm/workers-ai-gateway';
import { turnUsage } from '~/lib/.server/llm/workers-ai-telemetry';
import type { Tool } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { getPiModel } from '~/lib/.server/llm/pi-ai-models';
import { requireWorkersAiBuilderModel } from '~/lib/.server/llm/workers-ai-model-catalog';
import { completeToolCall } from '~/lib/.server/llm/pi-ai-invoke';
import { PROMPT_REFINEMENT_SYSTEM_PROMPT } from './enhance-prompt-prompt';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { logProviderFailure } from '~/lib/.server/llm/provider-error-logging';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import {
  promptRefinementRequestSchema,
  promptRefinementResultSchema,
  recommendedOptionFirst,
} from '~/lib/prompt-refinement';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';

const logger = createScopedLogger('EnhancePrompt');
/**
 * The refined prompt is short, but the pinned model reasons before it calls the tool, and that
 * reasoning spends the same output budget; the request's budget is now exactly what is asked for,
 * so it leaves room for both.
 */
const ENHANCE_PROMPT_MAX_OUTPUT_TOKENS = 4_096;
// Derived from the supported prompt size so the transport never rejects a prompt the product
// accepts: worst-case four UTF-8 bytes per character, plus room for the JSON envelope and answers.
const MAX_ENHANCE_PROMPT_REQUEST_BYTES = 4 * MAX_USER_MESSAGE_CHARACTERS + 64 * 1024;
const PROMPT_REFINEMENT_TOOL_NAME = 'submit_refined_app_plan';
const promptRefinementTool: Tool = {
  name: PROMPT_REFINEMENT_TOOL_NAME,
  description: 'Submit either the next product decision or the finalized app brief.',
  // SAFETY: `z.toJSONSchema` emits the draft-2020-12 JSON Schema object that pi-ai's `TSchema`
  // describes. The two libraries model the same document with structurally unrelated types.
  parameters: z.toJSONSchema(promptRefinementResultSchema) as Tool['parameters'],
};

export async function userRuntimeEnhancePromptAction({
  request,
  env,
  userId,
  confirmAccess = confirmUserWorkspaceAccess,
}: {
  request: Request;
  env: Env;
  userId: string;
  /** Asks the control plane about this person; the real call unless a test stands in for it. */
  confirmAccess?: ConfirmUserWorkspaceAccess;
}) {
  try {
    const parsedRequest = promptRefinementRequestSchema.safeParse(
      await readJsonBodyWithLimit(request, MAX_ENHANCE_PROMPT_REQUEST_BYTES, 'Prompt enhancement request'),
    );
    if (!parsedRequest.success) {
      return Response.json({ error: 'Invalid prompt' }, { status: 400 });
    }
    const { prompt, answers } = parsedRequest.data;
    const access = await modelRequestAccess(env, confirmAccess);
    if (!access.allowed) {
      return Response.json({ error: "You no longer have access to this team's account." }, { status: 403 });
    }
    let usage: Usage | null = null;
    const accountCredentials = await getUserWorkersAiCredentials(env, userId);
    // Prompt refinement runs the builder's own pinned model, resolved through the account's live
    // catalog rather than Pi's static entry alone: the live catalog says whether the account still
    // serves the pin and gives the window and capabilities Cloudflare reports for it now, so the two
    // paths stay the same model, and refinement inherits the pin's retirement failover for free.
    // It is CloudChef's own helper, not a choice from the picker, so the account's allowed models don't apply
    // (as with chat titles): the owner chose this, since it is a small Workers AI model run once per draft.
    const model = await requireWorkersAiBuilderModel(accountCredentials.binding, CLOUDFLARE_WORKERS_AI_MODEL);
    // The draft goes to the model, so it is logged in the account's AI Gateway only if the person allows it.
    const handle = getPiModel(accountCredentials, model.id, {
      model,
      gatewayLogging: workersAiGatewayLogging(access.contentLogging),
    });
    const result = promptRefinementResultSchema.safeParse(
      await completeToolCall(handle, {
        systemPrompt: PROMPT_REFINEMENT_SYSTEM_PROMPT,
        prompt: JSON.stringify({ draft: prompt, priorDecisions: answers }),
        tool: promptRefinementTool,
        maxTokens: ENHANCE_PROMPT_MAX_OUTPUT_TOKENS,
        onUsage: (spent) => {
          usage = spent;
        },
      }),
    );
    if (access.report && usage) {
      await access.report(turnUsage(usage)).catch(() => {
        console.warn('Unable to report prompt enhancement usage to the control plane');
      });
    }
    if (!result.success) {
      throw new Error('Workers AI returned an invalid prompt refinement result.');
    }
    if (result.data.kind === 'questions') {
      const questions = result.data.questions;
      const answeredQuestionIds = new Set(answers.map((answer) => answer.questionId));
      if (questions.some((question) => answeredQuestionIds.has(question.id))) {
        throw new Error('Workers AI repeated a prompt refinement question.');
      }
      return Response.json({
        ...result.data,
        questions: questions.map(recommendedOptionFirst),
      });
    }
    return Response.json(result.data);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return Response.json({ error: 'Invalid prompt' }, { status: 400 });
    }
    if (isWorkersAiFreeAllocationError(error)) {
      return Response.json({ code: 'workers_paid_required', error: workersPaidRequiredMessage() }, { status: 402 });
    }
    logProviderFailure(logger, 'Prompt enhancement request failed.', error);
    return Response.json({ error: 'Error enhancing prompt' }, { status: 500 });
  }
}
