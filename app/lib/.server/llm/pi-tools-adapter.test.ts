import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createWorkersAiTools: vi.fn(),
  toolNames: ['read', 'write', 'edit', 'exec'] as const,
}));

vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: mocks.createWorkersAiTools,
}));

import {
  BUILDER_TOOL_DEADLINES_MS,
  BUILDER_TOOL_STOP_GRACE_MS,
  BuilderToolDeadlineError,
  BuilderToolUnsettledError,
} from './builder-turn-limits';
import { createPiToolBundle } from './pi-tools-adapter';
import type { BuilderSkillReader } from './builder-skills';

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
    ['write', { path: '/home/project/src/app.ts', content: 'export {};' }],
    ['edit', { path: '/home/project/src/app.ts', old_string: 'export {};', new_string: 'changed' }],
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
      const tools = createPiToolBundle({} as never, operationContext(), NO_SKILLS);
      let rejection: unknown;
      const execution = tools[name].execute(`${name}-timeout`, input).catch((error) => {
        rejection = error;
      });
      const timeoutMs = BUILDER_TOOL_DEADLINES_MS[name];

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(rejection).toBeUndefined();
      expect(executionSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(rejection).toBeInstanceOf(BuilderToolDeadlineError);
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
      const tools = createPiToolBundle({} as never, operationContext(), NO_SKILLS);
      const execution = tools.write.execute('write-indeterminate', {
        path: '/home/project/src/app.ts',
        content: 'changed',
      });
      const rejection = expect(execution).rejects.toBe(indeterminate);

      await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS.write);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a write that landed as its deadline passed as the write, not as stopped', async () => {
    vi.useFakeTimers();
    try {
      const landed = { path: '/home/project/src/app.ts', bytesWritten: 7 };
      mocks.execute.mockImplementationOnce(
        async (_input, options) =>
          new Promise((resolve) => {
            options.abortSignal?.addEventListener('abort', () => resolve(landed), { once: true });
          }),
      );
      // SAFETY: the canonical tools are mocked, so the workspace is never read.
      const tools = createPiToolBundle({} as never, operationContext(), NO_SKILLS);
      const execution = tools.write.execute('write-late', { path: '/home/project/src/app.ts', content: 'changed' });
      const outcome = expect(execution).resolves.toMatchObject({ details: landed });

      await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS.write);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the call of a tool that ignores its deadline, saying its outcome is unknown', async () => {
    vi.useFakeTimers();
    try {
      mocks.execute.mockImplementationOnce(async () => new Promise(() => undefined));
      // SAFETY: the canonical tools are mocked, so the workspace is never read.
      const tools = createPiToolBundle({} as never, operationContext(), NO_SKILLS);
      let rejection: unknown;
      const execution = tools.exec.execute('exec-hung', { command: 'pnpm test' }).catch((error) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS.exec + BUILDER_TOOL_STOP_GRACE_MS - 1);
      expect(rejection).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(rejection).toBeInstanceOf(BuilderToolUnsettledError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid Zod input before canonical execution', async () => {
    const tools = createPiToolBundle({} as never, operationContext(), NO_SKILLS);

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

const NO_SKILLS: BuilderSkillReader = { read: async () => null };
