import type { Tool } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { getPiModel } from '~/lib/.server/llm/pi-ai-models';
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
import { MAX_USER_MESSAGE_CHARACTERS } from 'ghostbuild-agent/context-limits';

const logger = createScopedLogger('EnhancePrompt');
const ENHANCE_PROMPT_MAX_OUTPUT_TOKENS = 2_048;
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
}: {
  request: Request;
  env: Env;
  userId: string;
}) {
  try {
    const parsedRequest = promptRefinementRequestSchema.safeParse(
      await readJsonBodyWithLimit(request, MAX_ENHANCE_PROMPT_REQUEST_BYTES, 'Prompt enhancement request'),
    );
    if (!parsedRequest.success) {
      return Response.json({ error: 'Invalid prompt' }, { status: 400 });
    }
    const { prompt, answers } = parsedRequest.data;
    const accountCredentials = await getUserWorkersAiCredentials(env, userId);
    const handle = getPiModel(accountCredentials, CLOUDFLARE_WORKERS_AI_MODEL);
    const result = promptRefinementResultSchema.safeParse(
      await completeToolCall(handle, {
        systemPrompt: PROMPT_REFINEMENT_SYSTEM_PROMPT,
        prompt: JSON.stringify({ draft: prompt, priorDecisions: answers }),
        tool: promptRefinementTool,
        maxTokens: ENHANCE_PROMPT_MAX_OUTPUT_TOKENS,
      }),
    );
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
