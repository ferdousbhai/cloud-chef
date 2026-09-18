import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';

const mocks = vi.hoisted(() => ({
  completeToolCall: vi.fn(),
  getCredentials: vi.fn(),
  getPiModel: vi.fn(() => ({ model: { id: 'test' } })),
}));

vi.mock('~/lib/.server/cloudflare/workers-ai-billing-context', () => ({
  getUserWorkersAiCredentials: mocks.getCredentials,
}));
vi.mock('~/lib/.server/llm/pi-ai-models', () => ({ getPiModel: mocks.getPiModel }));
vi.mock('~/lib/.server/llm/pi-ai-invoke', () => ({ completeToolCall: mocks.completeToolCall }));

import { userRuntimeEnhancePromptAction } from './enhance-prompt';

function testEnv(): Env {
  // SAFETY: this handler reads no binding off `env`; the Workers AI credentials it uses come from
  // the mocked `getCredentials`, and `DB` is only present so the shape is non-empty.
  return { DB: {} } as Env;
}

function testAiBinding(): Ai {
  // SAFETY: the pi provider is mocked, so the binding is only ever passed through by identity.
  return {} as Ai;
}

/** A binding that answers the catalog read with the pinned model as Cloudflare describes it. */
function discoveringAiBinding(): Ai {
  const pinnedEntry: AiModelsSearchObject = {
    id: CLOUDFLARE_WORKERS_AI_MODEL,
    source: 1,
    name: CLOUDFLARE_WORKERS_AI_MODEL,
    description: 'Fast GLM model.',
    task: { id: 'text-generation', name: 'Text Generation', description: 'Text generation' },
    tags: [],
    properties: [
      { property_id: 'context_window', value: '1048576' },
      { property_id: 'function_calling', value: 'true' },
      { property_id: 'require_workers_paid', value: 'true' },
      { property_id: 'reasoning', value: 'true' },
      { property_id: 'vision', value: 'true' },
    ],
  };
  // SAFETY: the handler reaches only `models()` on this binding; the pi provider is mocked, so the
  // binding is otherwise passed through by identity.
  return { models: async () => [pinnedEntry] } as Ai;
}

function request(body: Record<string, unknown> = { prompt: 'Build a calendar' }) {
  return new Request('https://cloudchef.build/api/enhance-prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('userRuntimeEnhancePromptAction billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentials.mockResolvedValue({ binding: testAiBinding() });
    mocks.completeToolCall.mockResolvedValue({ kind: 'complete', enhancedPrompt: 'Build a detailed calendar' });
  });

  it('rejects an oversized prompt body before calling the provider', async () => {
    const response = await userRuntimeEnhPrompt({
      request: new Request('https://cloudchef.build/api/enhance-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Twice the worst-case byte budget for a supported prompt, so the transport must refuse it.
        body: JSON.stringify({ prompt: 'x'.repeat(8 * MAX_USER_MESSAGE_CHARACTERS) }),
      }),
      env: testEnv(),
    });

    expect(response.status).toBe(413);
    expect(mocks.completeToolCall).not.toHaveBeenCalled();
  });

  it('uses only the user-runtime binding', async () => {
    const credentials = { binding: testAiBinding() };
    mocks.getCredentials.mockResolvedValue(credentials);
    const response = await userRuntimeEnhPrompt({ request: request(), env: testEnv() });
    expect(response.status).toBe(200);
    // This binding cannot answer a catalog read, which is the discovery-unavailable path: the
    // pinned model still runs, from its reviewed literal.
    expect(mocks.getPiModel).toHaveBeenCalledWith(credentials, CLOUDFLARE_WORKERS_AI_MODEL, {
      model: DEFAULT_WORKERS_AI_MODEL,
    });
  });

  it('drives the pinned model with its discovered metadata, not pi-ai defaults', async () => {
    const credentials = { binding: discoveringAiBinding() };
    mocks.getCredentials.mockResolvedValue(credentials);

    const response = await userRuntimeEnhPrompt({ request: request(), env: testEnv() });

    expect(response.status).toBe(200);
    // Without this, `getPiModel` would size the builder's own million-token reasoning model as a
    // 128k non-reasoning one and skip the gateway routing the builder path gives it.
    expect(mocks.getPiModel).toHaveBeenCalledWith(credentials, CLOUDFLARE_WORKERS_AI_MODEL, {
      model: expect.objectContaining({ contextTokens: 1_048_576, reasoning: true, requiresPaid: true }),
    });
  });

  it('asks for explicit Workers Paid authorization when the connected free allocation is exhausted', async () => {
    mocks.getCredentials.mockResolvedValue({ binding: testAiBinding() });
    mocks.completeToolCall.mockRejectedValue(new Error('Workers Paid plan required after free AI allocation'));
    const response = await userRuntimeEnhPrompt({ request: request(), env: testEnv() });
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      code: 'workers_paid_required',
      error: expect.stringContaining('CLOUDCHEF_WORKERS_PAID_REQUIRED:'),
    });
  });

  it('does not log provider request bodies when prompt enhancement fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const providerError = Object.assign(new Error('provider failure'), {
      requestBodyValues: { prompt: 'SECRET_PROMPT_MARKER' },
    });
    mocks.completeToolCall.mockRejectedValue(providerError);

    const response = await userRuntimeEnhPrompt({ request: request(), env: testEnv() });

    expect(response.status).toBe(500);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET_PROMPT_MARKER');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('provider failure');
    consoleError.mockRestore();
  });

  it('rejects an invalid provider result instead of returning the original prompt as a successful enhancement', async () => {
    mocks.completeToolCall.mockResolvedValue({ kind: 'complete', enhancedPrompt: '   ' });

    const response = await userRuntimeEnhPrompt({ request: request(), env: testEnv() });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Error enhancing prompt' });
  });

  it('returns a validated question batch with each recommended option first', async () => {
    mocks.completeToolCall.mockResolvedValue({
      kind: 'questions',
      questions: [
        {
          id: 'sharing',
          header: 'Sharing',
          question: 'Who should be able to see each calendar?',
          options: [
            { id: 'private', label: 'Private', description: 'Only the creator can view it.' },
            { id: 'team', label: 'Shared team', description: 'Invited teammates can collaborate.' },
          ],
          recommendedOptionId: 'team',
        },
        {
          id: 'views',
          header: 'Views',
          question: 'Which views matter?',
          options: [
            { id: 'month', label: 'Month', description: 'Plan across the full month.' },
            { id: 'week', label: 'Week', description: 'Focus on the current week.' },
          ],
          multi: true,
          recommendedOptionId: 'month',
        },
      ],
    });

    const response = await userRuntimeEnhPrompt({ request: request(), env: testEnv() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: 'questions',
      questions: [
        { options: [{ id: 'team' }, { id: 'private' }] },
        { options: [{ id: 'month' }, { id: 'week' }], multi: true },
      ],
    });
  });

  it('passes prior decisions as untrusted user content', async () => {
    mocks.completeToolCall.mockResolvedValue({ kind: 'complete', enhancedPrompt: 'Build a shared team calendar.' });
    const answers = [
      {
        questionId: 'sharing',
        question: 'Who should be able to see each calendar?',
        selectedOptions: ['Shared team'],
        note: 'Guests can view a read-only public link.',
      },
    ];

    const response = await userRuntimeEnhPrompt({
      request: request({ prompt: 'Build a calendar', answers }),
      env: testEnv(),
    });

    expect(response.status).toBe(200);
    expect(mocks.completeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: JSON.stringify({ draft: 'Build a calendar', priorDecisions: answers }),
      }),
    );
  });

  it('fails closed if the model repeats an answered question', async () => {
    mocks.completeToolCall.mockResolvedValue({
      kind: 'questions',
      questions: [
        {
          id: 'sharing',
          header: 'Sharing',
          question: 'Who should be able to see each calendar?',
          options: [
            { id: 'private', label: 'Private', description: 'Only the creator can view it.' },
            { id: 'team', label: 'Shared team', description: 'Invited teammates can collaborate.' },
          ],
          recommendedOptionId: 'team',
        },
      ],
    });

    const response = await userRuntimeEnhPrompt({
      request: request({
        prompt: 'Build a calendar',
        answers: [
          {
            questionId: 'sharing',
            question: 'Who should be able to see each calendar?',
            selectedOptions: ['Shared team'],
          },
        ],
      }),
      env: testEnv(),
    });

    expect(response.status).toBe(500);
  });
});

function userRuntimeEnhPrompt(args: { request: Request; env: Env }) {
  return userRuntimeEnhancePromptAction({ ...args, userId: 'user-1' });
}
