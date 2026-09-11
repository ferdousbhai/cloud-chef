import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { z, type ZodType } from 'zod';
import {
  createTurnStatefulToolCoordinator,
  createWorkersAiTools,
  getValidatedBuildCompletion,
} from './workers-ai-tools';

type Tool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>;
};

describe('minimal Workers AI tool surface', () => {
  it('keeps the reviewed Computer schemas behind the active model tools', () => {
    const tools = createWorkersAiTools(workspaceStub(), operationContext());

    expect(Object.keys(tools)).toEqual([
      'read',
      'ls',
      'grep',
      'write',
      'edit',
      'exec',
      'validate',
      'search_cloudflare_docs',
    ]);
    expect(toolInputSchema(tools.ls).safeParse({}).success).toBe(true);
    expect(toolInputSchema(tools.ls).safeParse({ path: '/home/project/src', recursive: true, limit: 50 }).success).toBe(
      true,
    );
    expect(toolInputSchema(tools.grep).safeParse({ pattern: 'createRouter' }).success).toBe(true);
    expect(toolInputSchema(tools.grep).safeParse({ path: '/home/project/src' }).success).toBe(false);
    expect(
      toolInputSchema(tools.read).safeParse({ path: '/home/project/package.json', offset: 1, limit: 20 }).success,
    ).toBe(true);
    expect(toolInputSchema(tools.write).safeParse({ path: '/home/project/new.ts', content: 'export {}' }).success).toBe(
      true,
    );
    expect(
      toolInputSchema(tools.edit).safeParse({
        path: '/home/project/app.ts',
        base: 'A'.repeat(24),
        edits: [{ startLine: 1, endLine: 1, content: 'after' }],
      }).success,
    ).toBe(true);
    expect(toolInputSchema(tools.exec).safeParse({ command: 'rg TODO' }).success).toBe(true);
    expect(Object.keys(z.toJSONSchema(toolInputSchema(tools.exec)).properties ?? {})).toEqual(['command', 'cwd']);
  });

  it('reads bundled skill references through read without consulting the project workspace', async () => {
    const workspace = workspaceStub();
    const path = '/__skills__/cloudflare/references/workers-ai/README.md';
    const tools = createWorkersAiTools(workspace, operationContext(), {
      read: vi.fn(async (requestedPath) =>
        requestedPath === path ? { kind: 'file' as const, content: 'one\ntwo\nthree\n' } : null,
      ),
    });

    await expect(executeTool(tools.read, { path, offset: 2, limit: 1 })).resolves.toMatchObject({
      path,
      content: '2:two',
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      nextOffset: 3,
    });
    expect(workspace.readText).not.toHaveBeenCalled();
  });

  it('fails closed for unknown skill references and prevents skill writes', async () => {
    const workspace = workspaceStub();
    const path = '/__skills__/cloudflare/references/missing.md';
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.read, { path })).resolves.toMatchObject({
      error: expect.stringContaining('Skill reference not found'),
    });
    await expect(executeTool(tools.write, { path, content: 'changed' })).resolves.toMatchObject({
      error: expect.stringContaining('Skill files are read-only'),
    });
    await expect(
      executeTool(tools.write, {
        path: '/home/project/../../../__skills__/cloudflare/references/missing.md',
        content: 'changed',
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining('Skill files are read-only') });
    await expect(
      executeTool(tools.write, {
        path: '//__skills__//cloudflare-app-builder/references/missing.md',
        content: 'changed',
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining('Skill files are read-only') });
    expect(workspace.readText).not.toHaveBeenCalled();
    expect(workspace.computer.fs.writeFile).not.toHaveBeenCalled();
  });

  it('returns numbered project lines and the snapshot tag required by edit', async () => {
    const workspace = workspaceStub({ files: { '/home/project/src/app.ts': 'one\ntwo\nthree\n' } });
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(
      executeTool(tools.read, { path: '/home/project/src/app.ts', offset: 2, limit: 1 }),
    ).resolves.toMatchObject({
      path: '/home/project/src/app.ts',
      base: expect.stringMatching(/^[A-F0-9]{24}$/),
      content: '2:two',
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      nextOffset: 3,
    });
  });

  it('does not let an edit resume to write after cancellation while its snapshot read is pending', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub();
    const snapshot = deferred<Awaited<ReturnType<BuilderWorkspaceApi['readText']>>>();
    workspace.readText = vi.fn(() => snapshot.promise);
    const tools = createWorkersAiTools(workspace, operationContext());
    const controller = new AbortController();
    const reason = new DOMException('edit timed out', 'TimeoutError');

    const execution = executeTool(
      tools.edit,
      {
        path,
        base: 'A'.repeat(24),
        edits: [{ startLine: 1, endLine: 1, content: 'after' }],
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(workspace.readText).toHaveBeenCalledWith(path, controller.signal));
    controller.abort(reason);
    snapshot.resolve({
      path,
      content: 'before\n',
      encoding: 'utf8',
      size: 7,
      sha256: await sha256('before\n'),
      revision: 1,
    });

    await expect(execution).rejects.toBe(reason);
    expect(workspace.computer.fs.writeFile).not.toHaveBeenCalled();
  });

  it('waits for an in-flight edit write to settle and skips the post-write read after cancellation', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'before\n' } });
    const write = deferred<void>();
    const commitWrite = workspace.computer.fs.writeFile;
    workspace.computer.fs.writeFile = vi.fn(async (writePath, content, options) => {
      await write.promise;
      await commitWrite(writePath, content, options);
    });
    const tools = createWorkersAiTools(workspace, operationContext());
    const controller = new AbortController();
    const reason = new DOMException('edit timed out', 'TimeoutError');

    const execution = executeTool(
      tools.edit,
      {
        path,
        base: ((await executeTool(tools.read, { path })) as { base: string }).base,
        edits: [{ startLine: 1, endLine: 1, content: 'after' }],
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(workspace.computer.fs.writeFile).toHaveBeenCalledOnce());
    controller.abort(reason);

    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    write.resolve();
    await expect(execution).rejects.toBe(reason);
    expect(workspace.readText).toHaveBeenCalledTimes(2);
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'after\n' });
    await Promise.resolve();
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'after\n' });
  });

  it('does not let a write resume after cancellation while file metadata is pending', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'before\n' } });
    const stat = deferred<{ size: number; mtime: number; mode: number; isFile: boolean; isDirectory: boolean }>();
    workspace.computer.fs.stat = vi.fn(() => stat.promise);
    const tools = createWorkersAiTools(workspace, operationContext());
    const controller = new AbortController();
    const reason = new DOMException('write timed out', 'TimeoutError');

    const execution = executeTool(tools.write, { path, content: 'after\n' }, controller.signal);
    await vi.waitFor(() => expect(workspace.computer.fs.stat).toHaveBeenCalledWith(path));
    controller.abort(reason);
    stat.resolve({ size: 7, mtime: 1, mode: 0o755, isFile: true, isDirectory: false });

    await expect(execution).rejects.toBe(reason);
    expect(workspace.computer.fs.writeFile).not.toHaveBeenCalled();
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'before\n' });
  });

  it('waits for an in-flight write to settle before reporting timeout and leaves no later write', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'before\n' } });
    const write = deferred<void>();
    const commitWrite = workspace.computer.fs.writeFile;
    workspace.computer.fs.writeFile = vi.fn(async (writePath, content, options) => {
      await write.promise;
      await commitWrite(writePath, content, options);
    });
    const tools = createWorkersAiTools(workspace, operationContext());
    const controller = new AbortController();
    const reason = new DOMException('write timed out', 'TimeoutError');

    const execution = executeTool(tools.write, { path, content: 'after\n' }, controller.signal);
    await vi.waitFor(() => expect(workspace.computer.fs.writeFile).toHaveBeenCalledOnce());
    controller.abort(reason);

    let settled = false;
    void execution.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    write.resolve();
    await expect(execution).rejects.toBe(reason);
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'after\n' });
    await Promise.resolve();
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'after\n' });
  });

  it('rejects stale line edits and applies an exact-snapshot edit without an intermediate validation', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'one\ntwo\nthree\n' } });
    const tools = createWorkersAiTools(workspace, operationContext());
    const read = (await executeTool(tools.read, { path })) as { base: string };

    await expect(
      executeTool(tools.edit, {
        path,
        base: 'F'.repeat(24),
        edits: [{ startLine: 2, endLine: 2, content: 'stale' }],
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining('changed after it was read') });
    expect(workspace.validate).not.toHaveBeenCalled();

    await expect(
      executeTool(tools.edit, {
        path,
        base: read.base,
        edits: [
          { startLine: 2, endLine: 2, content: 'TWO' },
          { afterLine: 3, content: 'four' },
        ],
      }),
    ).resolves.toMatchObject({
      base: expect.stringMatching(/^[A-F0-9]{24}$/),
      editsApplied: 2,
      firstChangedLine: 2,
      totalLines: 4,
    });
    expect(workspace.validate).not.toHaveBeenCalled();
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'one\nTWO\nthree\nfour\n' });
  });

  it('does not validate read-only exec commands', async () => {
    const runtimeExec = vi.fn(async () => ({
      result: async () => ({ exitCode: 0, stdout: 'src\n', stderr: '' }),
    }));
    const workspace = workspaceStub({ runtimeExec });
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'rg TODO' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'src\n',
    });
    expect(runtimeExec).toHaveBeenCalledWith('rg TODO', {
      cwd: undefined,
      encoding: 'utf8',
      backend: 'container-shell',
    });
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('does not mask an indeterminate workspace settlement as an ordinary tool error or timeout', async () => {
    const workspace = workspaceStub();
    const controller = new AbortController();
    const timeout = new DOMException('write timed out', 'TimeoutError');
    const indeterminate = Object.assign(new Error('workspace outcome is indeterminate'), {
      code: 'workspace_tool_operation_indeterminate',
    });
    workspace.executeToolOnce = vi.fn(async () => {
      controller.abort(timeout);
      throw indeterminate;
    });
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(
      executeTool(tools.write, { path: '/home/project/src/app.ts', content: 'changed' }, controller.signal),
    ).rejects.toBe(indeterminate);
  });

  it('propagates cancellation through exec and rejects a result completed after abort', async () => {
    const command = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    const workspace = workspaceStub();
    workspace.executeCommand = vi.fn(() => command.promise);
    const tools = createWorkersAiTools(workspace, operationContext());
    const controller = new AbortController();
    const reason = new DOMException('exec timed out', 'TimeoutError');

    const execution = executeTool(tools.exec, { command: 'pnpm test' }, controller.signal);
    await vi.waitFor(() =>
      expect(workspace.executeCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'pnpm test', abortSignal: controller.signal }),
      ),
    );
    controller.abort(reason);
    command.resolve({ exitCode: 0, stdout: 'late\n', stderr: '' });

    await expect(execution).rejects.toBe(reason);
  });

  it('preserves command output while marking a non-zero exit as a tool failure', async () => {
    const workspace = workspaceStub({
      runtimeExec: vi.fn(async () => ({
        result: async () => ({ exitCode: 2, stdout: 'tests ran\n', stderr: 'failed\n' }),
      })),
    });
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'pnpm test' })).resolves.toMatchObject({
      exitCode: 2,
      stdout: 'tests ran\n',
      stderr: 'failed\n',
      error: 'Command exited with code 2.',
    });
  });

  it('defers validation while related file mutations are being batched', async () => {
    const workspace = workspaceStub();
    const onValidationStage = vi.fn();
    const tools = createWorkersAiTools(workspace, operationContext({ onValidationStage }));

    const result = await executeTool(tools.write, {
      path: '/home/project/src/app.ts',
      content: 'export const ready = true;',
    });

    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
    expect(onValidationStage).not.toHaveBeenCalled();
  });

  it('does not claim completion when a failed write left the durable revision unchanged', async () => {
    const workspace = workspaceStub();
    workspace.computer.fs.writeFile = vi.fn(async () => {
      throw new Error('write failed');
    });
    const tools = createWorkersAiTools(workspace, operationContext());

    const result = await executeTool(tools.write, { path: '/home/project/src/app.ts', content: 'bad' });

    expect(result).toMatchObject({ error: expect.stringContaining('write failed') });
    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('routes approved dependency commands through the durable installer without an intermediate validation', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    const result = await executeTool(tools.exec, { command: 'pnpm add date-fns' });

    expect(workspace.installDependencies).toHaveBeenCalledWith({
      toolCallId: 'tool-call',
      input: { mode: 'add', packages: 'date-fns' },
      mode: 'add',
      packages: ['date-fns'],
    });
    expect(result).toMatchObject({ dependencyMutation: true });
    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
    expect(workspace.computer.runtime!.exec).not.toHaveBeenCalled();
  });

  it('does not let malformed dependency commands fall through to the shell', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'pnpm install' })).resolves.toMatchObject({
      error: expect.stringContaining('exec accepts only'),
    });
    expect(workspace.computer.runtime!.exec).not.toHaveBeenCalled();
    expect(workspace.installDependencies).not.toHaveBeenCalled();
  });

  it('does not infer validation from arbitrary exec mutations', async () => {
    let revision = 1;
    const runtimeExec = vi.fn(async () => ({
      result: async () => {
        revision = 2;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }));
    const workspace = workspaceStub({ runtimeExec, revision: () => revision });
    const tools = createWorkersAiTools(workspace, operationContext());

    const result = await executeTool(tools.exec, { command: 'custom-command' });

    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it.each([
    'pnpm run validate',
    'pnpm run validate 2>&1',
    'cd /home/project && pnpm run validate',
    'cd /home/project && pnpm run validate 2>&1',
  ])('routes %s through one durable validation and reports failures for model repair', async (command) => {
    const validation = toolFailure('Typecheck failed', { diagnostics: ['src/app.ts:1'] });
    const workspace = workspaceStub({ validation });
    const onValidationStage = vi.fn();
    const tools = createWorkersAiTools(workspace, operationContext({ onValidationStage }));

    await expect(executeTool(tools.exec, { command })).resolves.toMatchObject({ validation });
    expect(workspace.validate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tool-call:validation', input: {}, abortSignal: undefined }),
    );
    expect(onValidationStage.mock.calls).toEqual([
      ['tool-call', 'computer validation'],
      ['tool-call', null],
    ]);
    expect(workspace.computer.runtime!.exec).not.toHaveBeenCalled();
    expect(
      getValidatedBuildCompletion([user('Build it')], [{ toolName: 'exec', result: { validation } }]),
    ).toBeUndefined();
  });

  it('rejects long-running server commands before they reach the workspace', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'pnpm run dev' })).resolves.toMatchObject({
      error: expect.stringMatching(/long-running servers/),
    });
    expect(workspace.executeCommand).not.toHaveBeenCalled();
    expect(workspace.executeToolOnce).not.toHaveBeenCalled();
  });

  it('rejects platform process and runtime-state commands with a concise tool error', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'pkill -f workerd' })).resolves.toMatchObject({
      error: expect.stringMatching(/process management/i),
    });
    await expect(executeTool(tools.exec, { command: 'rm -rf .wrangler' })).resolves.toMatchObject({
      error: expect.stringMatching(/platform runtime state/i),
    });
    expect(workspace.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects a wrangler.jsonc write that removes a required template binding', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(
      executeTool(tools.write, {
        path: '/home/project/wrangler.jsonc',
        content: '{ "name": "app", "d1_databases": [{ "binding": "DB" }] }',
      }),
    ).resolves.toMatchObject({ error: expect.stringMatching(/required DB, APP_STORAGE, and APP_CACHE bindings/) });
    expect(workspace.computer.fs.writeFile).not.toHaveBeenCalled();
  });

  it('publishes every stage the workspace reports while the validation runs', async () => {
    const workspace = workspaceStub({
      onValidate: (args) => {
        args.onStage?.('installing');
        args.onStage?.('typecheck');
        args.onStage?.('build');
      },
    });
    const stages: Array<BuilderValidationStage | null> = [];
    const tools = createWorkersAiTools(
      workspace,
      operationContext({ onValidationStage: (_toolCallId, stage) => stages.push(stage) }),
    );

    await executeTool(tools.validate, {});

    expect(stages).toEqual(['computer validation', 'installing', 'typecheck', 'build', null]);
  });

  it('runs the canonical validation through the dedicated validate tool', async () => {
    const workspace = workspaceStub();
    const stages: Array<BuilderValidationStage | null> = [];
    const tools = createWorkersAiTools(
      workspace,
      operationContext({ onValidationStage: (_toolCallId, stage) => stages.push(stage) }),
    );

    const result = await executeTool(tools.validate, {});

    expect(result).toEqual({ validation: validationResult() });
    expect(workspace.validate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tool-call:validation', input: {} }),
    );
    expect(stages).toEqual(['computer validation', null]);
    expect(getValidatedBuildCompletion([user('Build it')], [{ toolName: 'validate', result }])).toContain(
      'validated the app',
    );
  });

  it('derives completion from the latest explicit validation receipt', () => {
    expect(
      getValidatedBuildCompletion(
        [user('Build it')],
        [{ toolName: 'exec', result: { validation: validationResult() } }],
      ),
    ).toBe(
      'Done. I built and validated the app. The hosted preview is publishing now, and deployment follows automatically.',
    );

    expect(
      getValidatedBuildCompletion(
        [user('Build it')],
        [
          { toolName: 'exec', result: { validation: validationResult() } },
          { toolName: 'exec', result: { validation: toolFailure('Build failed') } },
        ],
      ),
    ).toBeUndefined();
  });

  it('discards a validation receipt that a later mutation outlived', () => {
    // The receipt describes the revision it validated, not the one the turn ends on.
    for (const mutation of [
      { toolName: 'write', result: { path: '/home/project/src/index.ts' } },
      { toolName: 'edit', result: { path: '/home/project/src/index.ts' } },
      { toolName: 'exec', result: { exitCode: 0 } },
      { toolName: 'exec', result: { dependencyMutation: true } },
    ]) {
      expect(
        getValidatedBuildCompletion(
          [user('Build it')],
          [{ toolName: 'validate', result: { validation: validationResult() } }, mutation],
        ),
      ).toBeUndefined();
    }
  });

  it('serializes stateful work and keeps read-only work outside the queue', async () => {
    const events: string[] = [];
    let finishWrite: (() => void) | undefined;
    let keepAliveCalls = 0;
    const coordinate = createTurnStatefulToolCoordinator(async (operation) => {
      keepAliveCalls += 1;
      return operation();
    });
    const write = coordinate('write', async () => {
      events.push('write-start');
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      events.push('write-end');
    });
    const edit = coordinate('edit', async () => events.push('edit'));
    // Every VFS-served tool resolves while the write still holds the queue; a discovery call that
    // waited here would have re-acquired the container latency it exists to skip.
    await expect(coordinate('read', async () => 'contents')).resolves.toBe('contents');
    await expect(coordinate('ls', async () => 'entries')).resolves.toBe('entries');
    await expect(coordinate('grep', async () => 'matches')).resolves.toBe('matches');

    await Promise.resolve();
    expect(events).toEqual(['write-start']);
    finishWrite?.();
    await Promise.all([write, edit]);
    expect(events).toEqual(['write-start', 'write-end', 'edit']);
    expect(keepAliveCalls).toBe(2);
  });

  it('serves discovery from the workspace index, outside the container and the tool journal', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.ls, { path: '/home/project/src', recursive: true })).resolves.toMatchObject({
      path: '/home/project/src',
      recursive: true,
    });
    await expect(executeTool(tools.grep, { pattern: 'createRouter', ignoreCase: true })).resolves.toMatchObject({
      pattern: 'createRouter',
    });

    expect(workspace.listProjectEntries).toHaveBeenCalledWith(
      { path: '/home/project/src', recursive: true },
      undefined,
    );
    expect(workspace.searchProjectFiles).toHaveBeenCalledWith({ pattern: 'createRouter', ignoreCase: true }, undefined);
    expect(workspace.executeToolOnce).not.toHaveBeenCalled();
    expect(workspace.executeCommand).not.toHaveBeenCalled();
    expect(workspace.computer.runtime?.exec).not.toHaveBeenCalled();
  });

  it('keeps the read-only skill overlay out of project discovery', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.ls, { path: '/__skills__/react-start' })).resolves.toMatchObject({
      error: expect.stringContaining('not part of the project workspace'),
    });
    await expect(
      executeTool(tools.grep, { pattern: 'design', path: '//__skills__//frontend-design' }),
    ).resolves.toMatchObject({ error: expect.stringContaining('not part of the project workspace') });
    expect(workspace.listProjectEntries).not.toHaveBeenCalled();
    expect(workspace.searchProjectFiles).not.toHaveBeenCalled();
  });
});

function validationResult() {
  return toolSuccess('validated', {
    level: 'full',
    revision: 'a'.repeat(64),
    nextAction: 'prepare-deployment',
  });
}

function operationContext(
  overrides: {
    onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  } = {},
) {
  return {
    onValidationStage: overrides.onValidationStage,
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
  };
}

function workspaceStub(
  options: {
    runtimeExec?: (
      command: string,
      options: { cwd?: string; encoding: 'utf8'; backend?: string },
    ) => Promise<{ result(): Promise<{ exitCode: number; stdout: string; stderr: string }> }>;
    validation?: unknown;
    onValidate?: (args: { onStage?: (stage: BuilderValidationStage) => void }) => void;
    revision?: () => number;
    files?: Record<string, string>;
  } = {},
): BuilderWorkspaceApi {
  const runtimeExec =
    options.runtimeExec ?? vi.fn(async () => ({ result: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }));
  let localRevision = 1;
  const files = new Map(Object.entries(options.files ?? {}));
  const revision = options.revision ?? (() => localRevision);
  const state = () => ({
    initialized: true,
    revision: revision(),
    resetRevision: 0,
    fileCount: 0,
    totalBytes: 0,
    seeding: false,
  });
  const workspace = {
    computer: {
      fs: {
        stat: vi.fn(async () => ({ size: 0, mtime: 0, mode: 0, isFile: true, isDirectory: false })),
        readFile: vi.fn(),
        writeFile: vi.fn(async (path: string, content: Uint8Array) => {
          files.set(path, new TextDecoder().decode(content));
          localRevision += 1;
        }),
        mkdir: vi.fn(),
        rm: vi.fn(),
        readdir: vi.fn(),
      },
      runtime: { exec: runtimeExec },
    },
    refresh: vi.fn(async () => state()),
    getState: vi.fn(() => state()),
    readText: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return {
        path,
        content,
        encoding: 'utf8' as const,
        size: new TextEncoder().encode(content).byteLength,
        sha256: await sha256(content),
        revision: revision(),
      };
    }),
    executeCommand: vi.fn(async (args) => {
      const handle = await runtimeExec(args.command, {
        cwd: args.cwd,
        encoding: 'utf8',
        backend: args.backend ?? 'container-shell',
      });
      return handle.result();
    }),
    listProjectEntries: vi.fn(async (request: { path?: string; recursive?: boolean }) => ({
      path: request.path ?? '/home/project',
      recursive: request.recursive ?? false,
      entries: [],
      entryCount: 0,
      truncated: false,
      revision: revision(),
    })),
    searchProjectFiles: vi.fn(async (request: { pattern: string; path?: string }) => ({
      pattern: request.pattern,
      path: request.path ?? '/home/project',
      matches: [],
      matchCount: 0,
      filesScanned: 0,
      filesSkipped: 0,
      truncated: false,
      revision: revision(),
    })),
    executeToolOnce: vi.fn(async (_toolCallId, _toolName, _input, execute) => execute()),
    installDependencies: vi.fn(async () => {
      localRevision += 1;
      return toolSuccess('installed');
    }),
    validate: vi.fn(async (args: { onStage?: (stage: BuilderValidationStage) => void }) => {
      options.onValidate?.(args);
      return options.validation ?? validationResult();
    }),
  };
  return workspace as unknown as BuilderWorkspaceApi;
}

function user(text: string): GhostbuildMessage {
  return { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
}

async function executeTool(definition: Tool, input: unknown, abortSignal?: AbortSignal) {
  if (!definition.execute) {
    throw new Error('Expected an executable tool.');
  }
  return definition.execute(input, { toolCallId: 'tool-call', abortSignal });
}

function toolInputSchema(definition: Tool): ZodType {
  return definition.inputSchema as ZodType;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
