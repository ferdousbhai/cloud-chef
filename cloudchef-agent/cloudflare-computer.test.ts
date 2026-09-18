import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_COMPUTER_VERSION,
  GENERATED_PROJECT_PNPM_VERSION,
  COMPUTER_AI_TOOL_OPTIONS,
  COMPUTER_DEFAULT_SHELL_BACKEND,
  COMPUTER_EXEC_APPLICATION_POLICY,
  COMPUTER_SHELL_BACKEND_IDS,
  COMPUTER_SHELL_TOOL_OPTIONS,
  COMPUTER_TOOL_LIMITS,
  computerSyncUnconfirmedToolResult,
  workspaceOperationConflict,
  workspaceOperationConflictMessage,
} from './cloudflare-computer.js';

/**
 * CloudChef does not use the published AI SDK tools; every model tool is hand
 * written. The upstream blast radius is the durable workspace surface the
 * ProjectWorkspace runtime calls directly, so that is what the canary pins.
 * `readdir`, `stat`, and the utf8 `readFile` carry the VFS-only discovery tools
 * as well as `read`, so a drift in any of them breaks discovery before it breaks
 * anything the container could still answer.
 */
const REQUIRED_COMPUTER_DECLARATIONS = [
  'declare class Workspace {',
  'get fs(): WorkspaceFilesystem;',
  'get runtime(): WorkspaceRuntime;',
  'provider(): SQLiteWorkspaceProvider;',
  'stub(): WorkspaceStub;',
  'push(id?: string): Promise<number>;',
  'pull(id?: string): Promise<ApplyResult>;',
  'retryPendingSync(id?: string): Promise<WorkspaceRetryPendingSyncResult>;',
  'close(): Promise<void>;',
  'declare class WorkspaceFilesystem {',
  'readFile(path: string, encoding: "utf8"): Promise<string>;',
  'stat(path: string): Promise<WorkspaceStatResult>;',
  'readdir(path: string, options?: ReaddirOptions): Promise<WorkspaceDirentResult[]>;',
  'find(directory: string, pattern?: string, options?: FindOptions): Promise<WorkspaceFoundEntry[]>;',
  'grep(pattern: string, path: string, options?: GrepOptions): Promise<WorkspaceGrepMatch[]>;',
  'mkdir(path: string, options?: MkdirOptions): Promise<void>;',
  'rm(path: string, options?: RmOptions): Promise<void>;',
  'declare class WorkspaceRuntime {',
  'exec(source: string, options: WorkspaceRuntimeExecOptions<"utf8">): Promise<WorkspaceRuntimeExecHandle<"utf8">>;',
  'disposeExec(id: string, options?: WorkspaceRuntimeDisposeOptions): Promise<void>;',
  'interface SyncRetryScheduler {',
  'get(backend: string): Promise<SyncRetryIntent | undefined>;',
  'schedule(intent: SyncRetryIntent): Promise<void>;',
  'clear(backend: string): Promise<void>;',
] as const;

/**
 * Post-image of patches/@cloudflare__computer@0.2.1.patch. Patching a preview
 * dependency's published bundle silently stops applying when upstream reflows
 * the region, so the reviewed bytes are pinned here as well.
 */
const PATCHED_PROBE_BATCH_REGION = [
  '\tfor (const b of bytes) out += b.toString(16).padStart(2, "0");',
  '\treturn out;',
  '}',
  'const PROBE_BATCH = 64;',
  'function hasObjects(db, hashes) {',
  '\tif (hashes.length === 0) return [];',
  '\tconst present = /* @__PURE__ */ new Set();',
].join('\n');

/**
 * Post-image of the nested-transaction hunk in the same patch. Computer's own writeFileSync
 * opens a transaction inside the one applyAtomicWorkspaceChanges opens, and upstream serves
 * that nested case with raw SAVEPOINT SQL a Durable Object rejects, so every write failed.
 * Running the nested closure inline is complete rather than expedient: the outermost
 * storage.transactionSync already commits or rolls back the whole nesting, and nothing here
 * catches inside a nested transaction in order to continue, which is the only thing a
 * savepoint's partial rollback would add.
 */
const PATCHED_NESTED_TRANSACTION_REGION = [
  '\t\t\t\tthis.#txDepth++;',
  '\t\t\t\ttry {',
  '\t\t\t\t\treturn closure();',
  '\t\t\t\t} finally {',
  '\t\t\t\t\tthis.#txDepth--;',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t\tthis.#txDepth++;',
].join('\n');

describe('Cloudflare Computer preview contract', () => {
  it('recognizes both thrown and official wrapped pending-sync failures', () => {
    const message = '[workspace_sync_pending] Computer synchronization is pending.';
    expect(computerSyncUnconfirmedToolResult(new Error(message))).toMatchObject({
      status: 'pending',
      acknowledgement: 'pending',
    });
    expect(computerSyncUnconfirmedToolResult({ error: message })).toMatchObject({
      code: 'workspace_sync_pending',
      error: message,
    });
    expect(computerSyncUnconfirmedToolResult({ error: 'ordinary failure' })).toBeNull();
  });

  it('carries the operation-lane conflict code and retry budget across Workers RPC', () => {
    const message = workspaceOperationConflictMessage({ activeKind: 'validate', retryAfterMs: 90_000 });
    expect(message).toBe('[workspace_operation_conflict] validate is running; retry after 90000ms.');
    expect(workspaceOperationConflict(new Error(message))).toEqual({ activeKind: 'validate', retryAfterMs: 90_000 });
    expect(workspaceOperationConflict(new Error('ordinary failure'))).toBeNull();
    expect(
      workspaceOperationConflict(
        new Error(workspaceOperationConflictMessage({ activeKind: 'stateful operation', retryAfterMs: 1_000 })),
      ),
    ).toEqual({ activeKind: 'stateful operation', retryAfterMs: 1_000 });
  });

  it('pins the reviewed preview package without a release-age exception', () => {
    const rootPackage = jsonFile<{ dependencies?: Record<string, string>; packageManager?: string }>('../package.json');
    const installedPackage = jsonFile<{ version?: string }>('../node_modules/@cloudflare/computer/package.json');
    const workspaceConfig = textFile('../pnpm-workspace.yaml');
    const installedReadme = textFile('../node_modules/@cloudflare/computer/README.md');

    expect(rootPackage.dependencies?.['@cloudflare/computer']).toBe(CLOUDFLARE_COMPUTER_VERSION);
    expect(rootPackage.packageManager).toBe(`pnpm@${GENERATED_PROJECT_PNPM_VERSION}`);
    expect(installedPackage.version).toBe(CLOUDFLARE_COMPUTER_VERSION);
    expect(workspaceConfig).not.toContain('minimumReleaseAgeExclude');
    expect(installedReadme).toContain('**PREVIEW ONLY.**');
    expect(installedReadme).toContain('production use at this time.');
  });

  it('canaries the durable workspace surfaces the runtime executes', () => {
    const declarations = computerTypeDeclarations();
    for (const declaration of REQUIRED_COMPUTER_DECLARATIONS) {
      expect(declarations, declaration).toContain(declaration);
    }
  });

  it('canaries the reviewed SQL probe patch against the published bundle', () => {
    const workspaceConfig = textFile('../pnpm-workspace.yaml');
    const bundle = textFile('../node_modules/@cloudflare/computer/dist/index.js');

    expect(workspaceConfig).toContain(
      `'@cloudflare/computer@${CLOUDFLARE_COMPUTER_VERSION}': patches/@cloudflare__computer@${CLOUDFLARE_COMPUTER_VERSION}.patch`,
    );
    expect(bundle).toContain(PATCHED_PROBE_BATCH_REGION);
    expect(bundle).not.toContain('const PROBE_BATCH = 256;');
  });

  it('canaries the reviewed nested-transaction patch against the published bundle', () => {
    const bundle = textFile('../node_modules/@cloudflare/computer/dist/index.js');

    expect(bundle).toContain(PATCHED_NESTED_TRANSACTION_REGION);
    expect(bundle).not.toContain('this.sql.exec(`SAVEPOINT ${sp}`);');
    expect(bundle).not.toContain('this.sql.exec(`ROLLBACK TO ${sp}`);');
  });

  it('keeps backend selection explicit and every tool limit reviewed', () => {
    expect(COMPUTER_AI_TOOL_OPTIONS).toMatchObject({
      assets: false,
      read: {
        maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
        maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
      },
      write: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
      edit: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
      shell: { maxBytes: COMPUTER_TOOL_LIMITS.execMaxBytesPerStream },
    });
    expect(COMPUTER_SHELL_TOOL_OPTIONS.defaultBackend).toBe(COMPUTER_DEFAULT_SHELL_BACKEND);
    expect(Object.keys(COMPUTER_SHELL_TOOL_OPTIONS.backends)).toEqual(COMPUTER_SHELL_BACKEND_IDS);
    expect(
      Object.values(COMPUTER_SHELL_TOOL_OPTIONS.backends).every(({ description }) => description.length >= 80),
    ).toBe(true);
    expect(COMPUTER_SHELL_TOOL_OPTIONS.backends['container-shell'].description).toContain('public network access');
    expect(COMPUTER_SHELL_TOOL_OPTIONS.backends['container-shell'].description).toContain('pnpm');
    expect(COMPUTER_EXEC_APPLICATION_POLICY).toContain('do not start development, preview, watch');
    expect(COMPUTER_EXEC_APPLICATION_POLICY).toContain('CloudChef manages previews after validation');
  });
});

/** Shared declaration chunks carry content-hashed names, so read the whole published surface. */
function computerTypeDeclarations(): string {
  const directory = new URL('../node_modules/@cloudflare/computer/dist/', import.meta.url);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.d.ts'))
    .sort()
    .map((name) => readFileSync(new URL(name, directory), 'utf8'))
    .join('\n');
}

function jsonFile<T>(path: string): T {
  return JSON.parse(textFile(path)) as T;
}

function textFile(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}
