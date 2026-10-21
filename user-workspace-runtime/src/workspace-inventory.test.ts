import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../app/lib/hex-digest';
import { BUILDER_WORKSPACE_MAX_FILE_BYTES, BUILDER_WORKSPACE_MAX_FILES } from './protocol';
import {
  enumerateProjectFiles,
  type InventoryFilesystem,
  projectFileDigests,
  projectFileStats,
  type ProjectScope,
  workspaceLimitMessage,
} from './workspace-inventory';

const scope: ProjectScope = { root: '/home/project', excludedRoots: new Set(['node_modules', '.venv']) };

/**
 * A VFS whose files have sizes but no bytes until read, so a workspace far past its limits costs the
 * test nothing; `read` records every file read whole.
 */
function filesystem(sizes: Record<string, number>) {
  const files = new Map(Object.entries(sizes));
  const read: string[] = [];
  const fs: InventoryFilesystem = {
    find: async () => [...files.keys()].map((path) => ({ path, type: 'file' as const })),
    stat: async (path) => {
      const size = files.get(path);
      if (size === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return { size, mode: 0o644, isFile: true };
    },
    readFile: async (path) => {
      read.push(path);
      const size = files.get(path) ?? 0;
      let sent = 0;
      // Streamed in 1 MiB chunks: nothing downstream may need the file whole.
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) {
            controller.close();
            return;
          }
          const chunk = new Uint8Array(Math.min(1024 * 1024, size - sent)).fill(97);
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
    },
  };
  return { fs, files, read };
}

describe('a workspace a command left over its limits', () => {
  it('still has a state, a container digest, and a message saying what is over and how to fix it', async () => {
    const { fs, files, read } = filesystem({
      '/home/project/src/app.ts': 100,
      '/home/project/data/model.bin': BUILDER_WORKSPACE_MAX_FILE_BYTES * 3,
      '/home/project/node_modules/x/index.js': 10,
      '/home/project/.venv/lib/site.py': 10,
    });
    for (let index = 0; index < BUILDER_WORKSPACE_MAX_FILES; index += 1) {
      files.set(`/home/project/cache/${index}.json`, 2);
    }

    const stats = await projectFileStats(fs, scope);
    expect(stats).toHaveLength(BUILDER_WORKSPACE_MAX_FILES + 2);
    expect(read).toEqual([]);

    const message = workspaceLimitMessage('command', stats, scope);
    expect(message).toContain('After this command the project workspace is over its limits: 10,002 files');
    expect(message).toContain('files over the 16.0 MiB limit for one file: data/model.bin (48.0 MiB)');
    expect(message).toContain('The largest top-level entries are cache/ (10,000 files, 0.0 MiB)');
    expect(message).toContain('reading its state, saving changes, validating, and publishing fail');
    expect(message).toContain('rm -rf <directory>');
    expect(message).toContain('.venv, node_modules do not count.');

    // The check before a command hashes every counted file as it streams, the oversized one included.
    files.clear();
    files.set('/home/project/data/model.bin', BUILDER_WORKSPACE_MAX_FILE_BYTES + 1);
    const [digest] = await projectFileDigests(fs, scope);
    expect(digest).toEqual({
      path: '/home/project/data/model.bin',
      sha256: await sha256Hex(new Uint8Array(BUILDER_WORKSPACE_MAX_FILE_BYTES + 1).fill(97)),
    });
  });

  it('is back within its limits once the command that cleans up has run', async () => {
    const { fs, files } = filesystem({
      '/home/project/src/app.ts': 100,
      '/home/project/downloads/archive.zip': BUILDER_WORKSPACE_MAX_FILE_BYTES + 1,
    });
    expect(workspaceLimitMessage('workspace', await projectFileStats(fs, scope), scope)).toContain(
      'The project workspace is over its limits: files over the 16.0 MiB limit for one file: downloads/archive.zip',
    );

    files.delete('/home/project/downloads/archive.zip');

    expect(workspaceLimitMessage('workspace', await projectFileStats(fs, scope), scope)).toBeNull();
  });

  it('says a change would leave the project over its limits, and that deleting is always accepted', () => {
    const message = workspaceLimitMessage(
      'change',
      [{ path: '/home/project/big.bin', size: BUILDER_WORKSPACE_MAX_FILE_BYTES + 1 }],
      scope,
    );
    expect(message).toMatch(/^This change would leave the project workspace over its limits: /);
    expect(message).toContain('Deleting files is always accepted.');
  });

  it('counts neither installed nor built output', async () => {
    const { fs } = filesystem({
      '/home/project/src/app.ts': 1,
      '/home/project/node_modules/a.js': 1,
      '/home/project/.venv/b.py': 1,
    });
    expect(await enumerateProjectFiles(fs, scope)).toEqual(['/home/project/src/app.ts']);
  });
});

describe('ProjectWorkspace on a workspace over its limits', () => {
  const runtimeSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const method = (signature: string) => {
    const start = runtimeSource.indexOf(signature);
    expect(start).toBeGreaterThan(0);
    return runtimeSource.slice(start, runtimeSource.indexOf('\n  }\n', start));
  };

  // ProjectWorkspace needs a Container and Computer to construct, so what it reads on each recovery
  // path is read from its source.
  it('reports its state, accepts deletions, and checks the container before a command without a whole read', () => {
    expect(method('  async getWorkspaceState(')).toContain('this.stableProjectRead(readProjectFileStats)');
    const applyChanges = method('  async applyChanges(');
    expect(applyChanges).toContain("const deletionsOnly = changes.every((change) => change.kind === 'delete');");
    expect(applyChanges).toContain('deletionsOnly ? [] : await this.withComputer(readProjectFileStats)');
    expect(applyChanges).not.toContain('readProjectFiles');
    const containerCheck = method('  private async containerPathMatchesDurableProject(');
    expect(containerCheck).toContain('projectFileDigests(workspace.fs, PROJECT_SCOPE)');
    expect(containerCheck).not.toContain('readProjectFiles');
  });

  it('tells the model after a command that left the project over its limits', () => {
    const stream = method('  async executeStream(');
    expect(stream).toContain("workspaceLimitMessage('command', files, PROJECT_SCOPE)");
    expect(stream).toContain("type: 'workspace-limits'");
  });
});
