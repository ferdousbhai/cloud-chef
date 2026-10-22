import type { DurableObjectStorageLike, Workspace } from '@cloudflare/computer';
import { Workspace as ComputerWorkspace } from '@cloudflare/computer';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyAtomicWorkspaceChanges, isMissingPath } from './atomic-workspace-changes';

describe('isMissingPath', () => {
  it('recognizes a missing path by its code or by its message', () => {
    expect(isMissingPath(pathError('ENOENT'))).toBe(true);
    expect(isMissingPath(new Error('ENOENT: no such path: /home/project/a'))).toBe(true);
    expect(isMissingPath(new Error('no such file or directory'))).toBe(true);
    expect(isMissingPath(pathError('EACCES'))).toBe(false);
    expect(isMissingPath('ENOENT')).toBe(false);
  });
});

describe('applyAtomicWorkspaceChanges', () => {
  it('commits every write and recursive delete in one transaction', () => {
    const workspace = new TestWorkspace({ '/home/project/old/a.txt': { content: 'old', mode: 0o644 } });

    expect(
      applyAtomicWorkspaceChanges(workspace.asWorkspace(), [
        { kind: 'delete', path: '/home/project/old' },
        { kind: 'write', path: '/home/project/new/a.txt', bytes: new TextEncoder().encode('new'), mode: 0o755 },
      ]),
    ).toEqual(['/home/project/old', '/home/project/new/a.txt']);

    expect(workspace.files.has('/home/project/old/a.txt')).toBe(false);
    expect(workspace.files.get('/home/project/new/a.txt')).toEqual({ content: 'new', mode: 0o755 });
  });

  it('rolls back earlier changes when a later write fails', () => {
    const workspace = new TestWorkspace({
      '/home/project/a.txt': { content: 'before', mode: 0o644 },
      '/home/project/blocker': { content: 'file-not-directory', mode: 0o644 },
    });

    expect(() =>
      applyAtomicWorkspaceChanges(workspace.asWorkspace(), [
        { kind: 'write', path: '/home/project/a.txt', bytes: new TextEncoder().encode('after') },
        { kind: 'write', path: '/home/project/blocker/nested.txt', bytes: new TextEncoder().encode('never') },
      ]),
    ).toThrow('ENOTDIR');

    expect(workspace.files.get('/home/project/a.txt')?.content).toBe('before');
    expect(workspace.files.has('/home/project/blocker/nested.txt')).toBe(false);
  });

  it('rolls back the whole batch when cancellation is observed between changes', () => {
    const workspace = new TestWorkspace({
      '/home/project/a.txt': { content: 'before-a', mode: 0o644 },
      '/home/project/b.txt': { content: 'before-b', mode: 0o644 },
    });

    expect(() =>
      applyAtomicWorkspaceChanges(
        workspace.asWorkspace(),
        [
          { kind: 'write', path: '/home/project/a.txt', bytes: new TextEncoder().encode('after-a') },
          { kind: 'write', path: '/home/project/b.txt', bytes: new TextEncoder().encode('after-b') },
        ],
        (_change, index) => {
          if (index === 1) {
            throw new Error('cancelled');
          }
        },
      ),
    ).toThrow('cancelled');

    expect(workspace.files.get('/home/project/a.txt')?.content).toBe('before-a');
    expect(workspace.files.get('/home/project/b.txt')?.content).toBe('before-b');
  });
});

/**
 * The hand-written workspace above cannot model transaction depth, so it stayed green while
 * every production write failed: Computer's own writeFileSync opens a second transaction
 * inside the one this module opens, and upstream implemented that nested case with raw
 * SAVEPOINT SQL that a Durable Object refuses. These cases drive the real published VFS over
 * node:sqlite through storage that enforces the same refusal.
 */
describe('applyAtomicWorkspaceChanges on the real Computer VFS', () => {
  it('commits writes that open a nested transaction inside the change-set transaction', () => {
    const workspace = durableObjectLikeWorkspace();

    expect(
      applyAtomicWorkspaceChanges(workspace, [
        { kind: 'write', path: '/home/project/src/app.ts', bytes: new TextEncoder().encode('export default 1;') },
        { kind: 'write', path: '/home/project/README.md', bytes: new TextEncoder().encode('# app'), mode: 0o644 },
      ]),
    ).toEqual(['/home/project/src/app.ts', '/home/project/README.md']);

    const provider = workspace.provider();
    expect(provider.readFileSync('/home/project/src/app.ts', 'utf8')).toBe('export default 1;');
    expect(provider.readFileSync('/home/project/README.md', 'utf8')).toBe('# app');
  });

  it('still rolls the whole change set back through the outer transaction alone', () => {
    const workspace = durableObjectLikeWorkspace();
    workspace.provider().mkdirSync('/home/project', { recursive: true });

    expect(() =>
      applyAtomicWorkspaceChanges(
        workspace,
        [
          { kind: 'write', path: '/home/project/a.txt', bytes: new TextEncoder().encode('after-a') },
          { kind: 'write', path: '/home/project/b.txt', bytes: new TextEncoder().encode('after-b') },
        ],
        (_change, index) => {
          if (index === 1) {
            throw new Error('cancelled');
          }
        },
      ),
    ).toThrow('cancelled');

    expect(workspace.provider().readdirSync('/home/project')).toEqual([]);
  });
});

function durableObjectLikeWorkspace(): Workspace {
  return new ComputerWorkspace({ storage: new DurableObjectLikeStorage() });
}

/**
 * Durable Object storage: SQL transaction statements are rejected in favour of transactionSync,
 * which is the only boundary the runtime gets.
 */
class DurableObjectLikeStorage implements DurableObjectStorageLike {
  readonly #database = new DatabaseSync(':memory:');
  readonly sql = {
    exec: <Row extends object>(query: string, ...bindings: unknown[]) => {
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) {
        throw new Error(
          'To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.',
        );
      }
      // Only prepared statements return rows, and only one statement at a time; everything else
      // may be a multi-statement schema migration, which prepare() would silently truncate.
      if (
        bindings.length === 0 &&
        !/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query) &&
        !/\bRETURNING\b/i.test(query)
      ) {
        this.#database.exec(query);
        return { toArray: () => [] as Row[] };
      }
      const rows = this.#database.prepare(query).all(...(bindings as never[])) as unknown as Row[];
      return { toArray: () => rows };
    },
  };

  transactionSync<T>(closure: () => T): T {
    this.#database.exec('BEGIN');
    try {
      const result = closure();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}

type TestFile = { content: string; mode: number };

class TestWorkspace {
  files: Map<string, TestFile>;
  readonly directories = new Set(['/']);

  constructor(files: Record<string, TestFile>) {
    this.files = new Map(Object.entries(files));
    for (const path of this.files.keys()) {
      this.addParents(path);
    }
  }

  asWorkspace(): Workspace {
    return {
      db: {
        transactionSync: <T>(closure: () => T): T => {
          const files = new Map(this.files);
          const directories = new Set(this.directories);
          try {
            return closure();
          } catch (error) {
            this.files = files;
            this.directories.clear();
            for (const path of directories) {
              this.directories.add(path);
            }
            throw error;
          }
        },
      },
      provider: () => ({
        lstatSync: (path: string) => {
          const file = this.files.get(path);
          if (file) {
            return stat(false, file.mode);
          }
          if (this.directories.has(path)) {
            return stat(true, 0o755);
          }
          throw pathError('ENOENT');
        },
        readdirSync: (path: string) => this.children(path),
        unlinkSync: (path: string) => {
          if (!this.files.delete(path)) {
            throw pathError('ENOENT');
          }
        },
        rmdirSync: (path: string) => {
          if (this.children(path).length > 0) {
            throw pathError('ENOTEMPTY');
          }
          this.directories.delete(path);
        },
        mkdirSync: (path: string) => this.addDirectory(path),
        writeFileSync: (path: string, bytes: Uint8Array, options?: { mode?: number }) => {
          this.files.set(path, { content: new TextDecoder().decode(bytes), mode: options?.mode ?? 0o644 });
        },
      }),
    } as unknown as Workspace;
  }

  private addParents(path: string): void {
    const segments = path.split('/').slice(1, -1);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      this.directories.add(current);
    }
  }

  private addDirectory(path: string): void {
    const segments = path.split('/').slice(1);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      if (this.files.has(current)) {
        throw pathError('ENOTDIR');
      }
      this.directories.add(current);
    }
  }

  private children(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.directories, ...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && candidate !== path)
      .map((candidate) => candidate.slice(prefix.length).split('/')[0]!)
      .filter((name, index, names) => name && names.indexOf(name) === index);
  }
}

function stat(directory: boolean, mode: number) {
  return { isDirectory: () => directory, mode };
}

function pathError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
