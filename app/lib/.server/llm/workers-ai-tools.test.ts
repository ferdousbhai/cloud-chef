import { describe, expect, it, vi } from 'vitest';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { createTurnStatefulToolCoordinator, createWorkersAiTools } from './workers-ai-tools';
import type { BuilderSkillReader } from './builder-skills';

type Tool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>;
};

describe('minimal Workers AI tool surface', () => {
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
      content: 'two',
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
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

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

  it('returns plain project text and where to continue', async () => {
    const workspace = workspaceStub({ files: { '/home/project/src/app.ts': 'one\ntwo\nthree\n' } });
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(executeTool(tools.read, { path: '/home/project/src/app.ts', offset: 2, limit: 1 })).resolves.toEqual({
      path: '/home/project/src/app.ts',
      content: 'two',
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
    });
  });

  it('does not let an edit resume to write after cancellation while its read is pending', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub();
    const snapshot = deferred<Awaited<ReturnType<BuilderWorkspaceApi['readText']>>>();
    workspace.readText = vi.fn(() => snapshot.promise);
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);
    const controller = new AbortController();
    const reason = new DOMException('edit timed out', 'TimeoutError');

    const execution = executeTool(tools.edit, { path, old_string: 'before', new_string: 'after' }, controller.signal);
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

  it('reports an edit that landed as its stop arrived as applied', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'before\n' } });
    const controller = new AbortController();
    const commitWrite = workspace.computer.fs.writeFile;
    workspace.computer.fs.writeFile = vi.fn(async (writePath, content, options) => {
      controller.abort(new DOMException('edit timed out', 'TimeoutError'));
      await commitWrite(writePath, content, options);
    });
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);
    const landed = await executeTool(
      tools.edit,
      { path, old_string: 'before', new_string: 'after' },
      controller.signal,
    );

    expect(landed).toEqual({ path, replacements: 1 });
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'after\n' });
  });

  it('reports a write that landed as its stop arrived as written', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'before\n' } });
    const controller = new AbortController();
    const commitWrite = workspace.computer.fs.writeFile;
    workspace.computer.fs.writeFile = vi.fn(async (writePath, content, options) => {
      controller.abort(new DOMException('write timed out', 'TimeoutError'));
      await commitWrite(writePath, content, options);
    });
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(executeTool(tools.write, { path, content: 'after\n' }, controller.signal)).resolves.toEqual({
      path,
      bytesWritten: 6,
    });
    expect(workspace.computer.fs.writeFile).toHaveBeenCalledOnce();
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'after\n' });
  });

  it('does not let a write resume after cancellation while file metadata is pending', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'before\n' } });
    const stat = deferred<{ size: number; mtime: number; mode: number; isFile: boolean; isDirectory: boolean }>();
    workspace.computer.fs.stat = vi.fn(() => stat.promise);
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);
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

  it('replaces exact text, refusing missing or ambiguous text, without an intermediate validation', async () => {
    const path = '/home/project/src/app.ts';
    const workspace = workspaceStub({ files: { [path]: 'one\ntwo\ntwo\n' } });
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(executeTool(tools.edit, { path, old_string: 'three', new_string: '3' })).resolves.toMatchObject({
      error: expect.stringContaining('not found'),
    });
    await expect(executeTool(tools.edit, { path, old_string: 'two', new_string: '2' })).resolves.toMatchObject({
      error: expect.stringContaining('occurs 2 times'),
    });
    await expect(executeTool(tools.edit, { path, old_string: 'one', new_string: 'ONE' })).resolves.toEqual({
      path,
      replacements: 1,
    });
    await expect(
      executeTool(tools.edit, { path, old_string: 'two', new_string: 'TWO', replace_all: true }),
    ).resolves.toEqual({ path, replacements: 2 });
    expect(workspace.validate).not.toHaveBeenCalled();
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: 'ONE\nTWO\nTWO\n' });
  });

  it('refuses an edit that would grow the file past the write cap, writing nothing', async () => {
    const path = '/home/project/src/app.ts';
    const original = 'one\ntwo\n';
    const workspace = workspaceStub({ files: { [path]: original } });
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(
      executeTool(tools.edit, { path, old_string: 'two', new_string: 'x'.repeat(2 * 1024 * 1024) }),
    ).resolves.toMatchObject({ path, error: expect.stringContaining('byte file cap') });
    await expect(workspace.readText(path)).resolves.toMatchObject({ content: original });
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
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(
      executeTool(tools.write, { path: '/home/project/src/app.ts', content: 'changed' }, controller.signal),
    ).rejects.toBe(indeterminate);
  });

  it('propagates cancellation through exec and reports a command stopped mid-run as stopped', async () => {
    const workspace = workspaceStub();
    workspace.executeCommand = vi.fn<BuilderWorkspaceApi['executeCommand']>(
      ({ abortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        }),
    );
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);
    const controller = new AbortController();
    const reason = new DOMException('exec timed out', 'TimeoutError');

    const execution = executeTool(tools.exec, { command: 'pnpm test' }, controller.signal);
    await vi.waitFor(() =>
      expect(workspace.executeCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'pnpm test', abortSignal: controller.signal }),
      ),
    );
    controller.abort(reason);

    await expect(execution).rejects.toBe(reason);
  });

  it('reports a command that ran to completion as its stop arrived', async () => {
    const command = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    const workspace = workspaceStub();
    workspace.executeCommand = vi.fn(() => command.promise);
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);
    const controller = new AbortController();

    const execution = executeTool(tools.exec, { command: 'pnpm test' }, controller.signal);
    await vi.waitFor(() => expect(workspace.executeCommand).toHaveBeenCalledOnce());
    controller.abort(new DOMException('exec timed out', 'TimeoutError'));
    command.resolve({ exitCode: 0, stdout: 'done\n', stderr: '' });

    await expect(execution).resolves.toMatchObject({ command: 'pnpm test', exitCode: 0, stdout: 'done\n' });
  });

  it('preserves command output while marking a non-zero exit as a tool failure', async () => {
    const workspace = workspaceStub({
      runtimeExec: vi.fn(async () => ({
        result: async () => ({ exitCode: 2, stdout: 'tests ran\n', stderr: 'failed\n' }),
      })),
    });
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

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
    const tools = createWorkersAiTools(workspace, operationContext({ onValidationStage }), NO_SKILLS);

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
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    const result = await executeTool(tools.write, { path: '/home/project/src/app.ts', content: 'bad' });

    expect(result).toMatchObject({ error: expect.stringContaining('write failed') });
    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('routes approved dependency commands through the durable installer without an intermediate validation', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    const result = await executeTool(tools.exec, { command: 'pnpm add date-fns' });

    expect(workspace.installDependencies).toHaveBeenCalledWith({
      toolCallId: 'tool-call',
      input: { command: 'pnpm add date-fns' },
      mode: 'add',
      packages: ['date-fns'],
    });
    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
    expect(workspace.computer.runtime!.exec).not.toHaveBeenCalled();
  });

  it('refuses an install from outside the npm registry, and runs any other install as a command', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(executeTool(tools.exec, { command: 'npm install github:a/b' })).resolves.toMatchObject({
      error: expect.stringContaining('Only npm registry'),
    });
    expect(workspace.executeCommand).not.toHaveBeenCalled();
    await executeTool(tools.exec, { command: 'pnpm install' });
    expect(workspace.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'pnpm install' }));
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
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    const result = await executeTool(tools.exec, { command: 'custom-command' });

    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it.each(['pnpm run validate', 'pnpm run dev'])('runs %s as the command it is', async (command) => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await executeTool(tools.exec, { command });
    expect(workspace.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command }));
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('rejects platform process and runtime-state commands with a concise tool error', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await expect(executeTool(tools.exec, { command: 'pkill -f workerd' })).resolves.toMatchObject({
      error: expect.stringMatching(/platform runtime state/i),
    });
    await expect(executeTool(tools.exec, { command: 'rm -rf .wrangler' })).resolves.toMatchObject({
      error: expect.stringMatching(/platform runtime state/i),
    });
    expect(workspace.executeCommand).not.toHaveBeenCalled();
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
      NO_SKILLS,
    );

    await executeTool(tools.exec, { command: 'cloudchef validate' });

    expect(stages).toEqual(['computer validation', 'installing', 'typecheck', 'build', null]);
  });

  it('runs the canonical validation when exec is asked for exactly `cloudchef validate`', async () => {
    const workspace = workspaceStub();
    const stages: Array<BuilderValidationStage | null> = [];
    const tools = createWorkersAiTools(
      workspace,
      operationContext({ onValidationStage: (_toolCallId, stage) => stages.push(stage) }),
      NO_SKILLS,
    );

    const result = await executeTool(tools.exec, { command: '  cloudchef validate\n' });

    expect(result).toEqual({ command: '  cloudchef validate\n', validation: validationResult() });
    expect(workspace.validate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tool-call:validation', input: {} }),
    );
    expect(workspace.executeCommand).not.toHaveBeenCalled();
    expect(stages).toEqual(['computer validation', null]);
  });

  it('runs `cloudchef validate` inside a longer command line as an ordinary command', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext(), NO_SKILLS);

    await executeTool(tools.exec, { command: 'cloudchef validate && git push' });

    expect(workspace.validate).not.toHaveBeenCalled();
    expect(workspace.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'cloudchef validate && git push' }),
    );
  });

  it("settles a finished command's Cloudflare change and keeps one filed for a team's admins in its output", async () => {
    const workspace = workspaceStub();
    const filed = {
      kind: 'cloudflare_request_filed' as const,
      status: 'awaiting_team_admin' as const,
      approvalId: 'approval-1',
      accountId: 'account-1',
      request: {
        method: 'POST' as const,
        url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/domains',
      },
      riskNote: 'risk',
      expiresAt: 1,
      note: 'Filed.',
    };
    const cloudflareChange = vi.fn(async () => filed);
    const tools = createWorkersAiTools(workspace, { ...operationContext(), cloudflareChange }, NO_SKILLS);

    await expect(executeTool(tools.exec, { command: 'cf workers domains create' })).resolves.toMatchObject({
      cloudflareChange: filed,
    });
    expect(cloudflareChange).toHaveBeenCalledWith('tool-call');
  });

  it('offers the model exactly read, write, edit and exec', () => {
    expect(Object.keys(createWorkersAiTools(workspaceStub(), operationContext(), NO_SKILLS))).toEqual([
      'read',
      'write',
      'edit',
      'exec',
    ]);
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
    // A VFS-served read resolves while the write still holds the queue; a read that waited here would
    // have re-acquired the container latency it exists to skip.
    await expect(coordinate('read', async () => 'contents')).resolves.toBe('contents');

    await Promise.resolve();
    expect(events).toEqual(['write-start']);
    finishWrite?.();
    await Promise.all([write, edit]);
    expect(events).toEqual(['write-start', 'write-end', 'edit']);
    expect(keepAliveCalls).toBe(2);
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

async function executeTool(definition: Tool, input: unknown, abortSignal?: AbortSignal) {
  if (!definition.execute) {
    throw new Error('Expected an executable tool.');
  }
  return definition.execute(input, { toolCallId: 'tool-call', abortSignal });
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

const NO_SKILLS: BuilderSkillReader = { read: async () => null };
