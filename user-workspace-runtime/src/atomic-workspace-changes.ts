import type { Workspace } from '@cloudflare/computer';
import { Buffer } from 'node:buffer';
import { isRecord } from '../../cloudchef-agent/utils/isRecord';

export type AtomicWorkspaceChange =
  { kind: 'delete'; path: string } | { kind: 'write'; path: string; bytes: Uint8Array; mode?: number };

/** Apply a complete change set in one durable Computer VFS transaction. */
export function applyAtomicWorkspaceChanges(
  workspace: Workspace,
  changes: readonly AtomicWorkspaceChange[],
  beforeChange?: (change: AtomicWorkspaceChange, index: number) => void,
): string[] {
  const provider = workspace.provider();
  return workspace.db.transactionSync(() => {
    for (const [index, change] of changes.entries()) {
      beforeChange?.(change, index);
      if (change.kind === 'delete') {
        removePath(provider, change.path);
        continue;
      }
      provider.mkdirSync(parentPath(change.path), { recursive: true });
      const mode = change.mode ?? existingMode(provider, change.path);
      provider.writeFileSync(change.path, Buffer.from(change.bytes), mode === undefined ? undefined : { mode });
    }
    return changes.map((change) => change.path);
  });
}

type WorkspaceProvider = ReturnType<Workspace['provider']>;

function removePath(provider: WorkspaceProvider, path: string): void {
  let stat: ReturnType<WorkspaceProvider['lstatSync']>;
  try {
    stat = provider.lstatSync(path);
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    provider.unlinkSync(path);
    return;
  }
  // SAFETY: `readdirSync` widens to `VirtualDirentLike[]` only for `{ withFileTypes: true }`.
  // This call passes no options, so the provider returns the plain name list.
  const names = provider.readdirSync(path) as string[];
  for (const name of names) {
    removePath(provider, `${path}/${name}`);
  }
  provider.rmdirSync(path);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function existingMode(provider: WorkspaceProvider, path: string): number | undefined {
  try {
    return provider.lstatSync(path).mode;
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Whether a workspace filesystem error says the path does not exist, by its code or its message. */
export function isMissingPath(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error.code === 'ENOENT') {
    return true;
  }
  return typeof error.message === 'string' && /ENOENT|no such (?:file|path)/i.test(error.message);
}
