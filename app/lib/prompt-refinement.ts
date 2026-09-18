import { z } from 'zod';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';

const MAX_PROMPT_REFINEMENT_QUESTIONS_PER_ROUND = 8;
export const MAX_PROMPT_REFINEMENT_ANSWER_CHARACTERS = 2_000;

export const promptRefinementAnswerSchema = z
  .object({
    questionId: z.string().trim().min(1).max(64),
    question: z.string().trim().min(1).max(500),
    selectedOptions: z.array(z.string().trim().min(1).max(80)).max(5).default([]),
    customInput: z.string().trim().min(1).max(MAX_PROMPT_REFINEMENT_ANSWER_CHARACTERS).optional(),
    note: z.string().trim().min(1).max(MAX_PROMPT_REFINEMENT_ANSWER_CHARACTERS).optional(),
  })
  .strict()
  .superRefine((answer, context) => {
    if (answer.selectedOptions.length === 0 && answer.customInput === undefined) {
      context.addIssue({ code: 'custom', message: 'A refinement answer is required.' });
    }
    if (answer.selectedOptions.length > 0 && answer.customInput !== undefined) {
      context.addIssue({ code: 'custom', message: 'Choose options or provide custom input, not both.' });
    }
  });

export const promptRefinementRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARACTERS),
    answers: z.array(promptRefinementAnswerSchema).default([]),
  })
  .strict()
  .superRefine((request, context) => {
    const questionIds = new Set(request.answers.map((answer) => answer.questionId));
    if (questionIds.size !== request.answers.length) {
      context.addIssue({
        code: 'custom',
        message: 'Each refinement question may be answered once.',
        path: ['answers'],
      });
    }
  });

const promptRefinementOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
  })
  .strict();

export const promptRefinementQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    header: z.string().trim().min(1).max(32),
    question: z.string().trim().min(1).max(500),
    options: z.array(promptRefinementOptionSchema).min(2).max(5),
    multi: z.boolean().default(false),
    recommendedOptionId: z.string().trim().min(1).max(64),
  })
  .strict()
  .superRefine((question, context) => {
    const optionIds = new Set(question.options.map((option) => option.id));
    if (optionIds.size !== question.options.length) {
      context.addIssue({ code: 'custom', message: 'Question option IDs must be unique.', path: ['options'] });
    }
    if (!optionIds.has(question.recommendedOptionId)) {
      context.addIssue({
        code: 'custom',
        message: 'The recommended option must reference a provided option.',
        path: ['recommendedOptionId'],
      });
    }
  });

const promptRefinementQuestionsResultSchema = z
  .object({
    kind: z.literal('questions'),
    questions: z.array(promptRefinementQuestionSchema).min(1).max(MAX_PROMPT_REFINEMENT_QUESTIONS_PER_ROUND),
  })
  .strict()
  .superRefine((result, context) => {
    const questionIds = new Set(result.questions.map((question) => question.id));
    if (questionIds.size !== result.questions.length) {
      context.addIssue({ code: 'custom', message: 'Question IDs must be unique within a refinement round.' });
    }
  });

export const promptRefinementResultSchema = z.union([
  promptRefinementQuestionsResultSchema,
  z
    .object({
      kind: z.literal('complete'),
      enhancedPrompt: z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARACTERS),
    })
    .strict(),
]);

export type PromptRefinementAnswer = z.infer<typeof promptRefinementAnswerSchema>;
export type PromptRefinementQuestion = z.infer<typeof promptRefinementQuestionSchema>;

export function recommendedOptionFirst(question: PromptRefinementQuestion): PromptRefinementQuestion {
  return {
    ...question,
    options: [...question.options].sort((left, right) => {
      if (left.id === question.recommendedOptionId) {
        return -1;
      }
      if (right.id === question.recommendedOptionId) {
        return 1;
      }
      return 0;
    }),
  };
}
