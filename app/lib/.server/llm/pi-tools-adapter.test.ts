import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createWorkersAiTools: vi.fn(),
  toolNames: ['read', 'ls', 'grep', 'write', 'edit', 'exec', 'search_cloudflare_docs'] as const,
}));

vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: mocks.createWorkersAiTools,
}));

import { BUILDER_TURN_TIMEOUTS, BuilderTurnBudgetExceededError } from './builder-turn-budget';
import { createPiToolBundle } from './pi-tools-adapter';

describe('Pi tool adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ ok: true, summary: 'done' });
    mocks.createWorkersAiTools.mockReturnValue(
      Object.fromEntries(
        mocks.toolNames.map((name) => [
          name,
          {
            description: `${name} description`,
            inputSchema: MODEL_TOOL_INPUT_SCHEMAS[name],
            execute: mocks.execute,
          } satisfies Tool,
        ]),
      ),
    );
  });

  it.each([
    ['read', { path: '/home/project/src/app.ts' }],
    ['ls', { recursive: true }],
    ['grep', { pattern: 'createRouter' }],
    ['write', { path: '/home/project/src/app.ts', content: 'export {};' }],
    [
      'edit',
      {
        path: '/home/project/src/app.ts',
        base: 'A'.repeat(24),
        edits: [{ startLine: 1, endLine: 1, content: 'changed' }],
      },
    ],
    ['exec', { command: 'pnpm test' }],
  ] as const)('enforces the %s deadline with the typed builder timeout error', async (name, input) => {
    vi.useFakeTimers();
    try {
      let executionSignal: AbortSignal | undefined;
      mocks.execute.mockImplementationOnce(
        async (_input, options) =>
          new Promise((_resolve, reject) => {
            executionSignal = options.abortSignal;
            executionSignal?.addEventListener('abort', () => reject(executionSignal?.reason), { once: true });
          }),
      );
      const tools = createPiToolBundle({} as never, operationContext());
      let rejection: unknown;
      const execution = tools[name].execute(`${name}-timeout`, input).catch((error) => {
        rejection = error;
      });
      const timeoutMs = BUILDER_TURN_TIMEOUTS.tools[name];

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(rejection).toBeUndefined();
      expect(executionSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(rejection).toBeInstanceOf(BuilderTurnBudgetExceededError);
      expect(rejection).toMatchObject({ reason: 'tool_timeout' });
      expect(executionSignal?.reason).toBe(rejection);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an indeterminate settlement failure discovered after the tool timeout', async () => {
    vi.useFakeTimers();
    try {
      const indeterminate = Object.assign(new Error('workspace outcome is indeterminate'), {
        code: 'workspace_tool_operation_indeterminate',
      });
      mocks.execute.mockImplementationOnce(
        async (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener('abort', () => reject(indeterminate), { once: true });
          }),
      );
      const tools = createPiToolBundle({} as never, operationContext());
      const execution = tools.write.execute('write-indeterminate', {
        path: '/home/project/src/app.ts',
        content: 'changed',
      });
      const rejection = expect(execution).rejects.toBe(indeterminate);

      await vi.advanceTimersByTimeAsync(BUILDER_TURN_TIMEOUTS.tools.write);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid Zod input before canonical execution', async () => {
    const tools = createPiToolBundle({} as never, operationContext());

    await expect(tools.write.execute('write-invalid', { path: '/home/project/src/app.ts' })).rejects.toThrow(
      'Invalid tool input for "write"',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

function operationContext() {
  return {
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
  };
}
