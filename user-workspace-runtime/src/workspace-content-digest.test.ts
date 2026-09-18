import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  isolatedContentDigestCommand,
  projectContentDigest,
  projectContentDigestInput,
} from './workspace-content-digest';

const EXCLUDED = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler']);
const scratch = mkdtempSync(join(tmpdir(), 'cloudchef-digest-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

/** Write a tree on disk and return the VFS-shaped file list describing the same content. */
function tree(name: string, files: Record<string, string>) {
  const root = join(scratch, name);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const vfs = Object.entries(files).map(([relative, content]) => ({
    path: `/home/project/${relative}`,
    sha256: sha(content),
  }));
  return { root, vfs };
}

const relative = (path: string) => path.replace('/home/project/', '');

type VfsFile = { path: string; sha256: string };

/** The durable side: hash the VFS file list the workspace would report. */
function vfsDigest(vfs: readonly VfsFile[]) {
  return projectContentDigest(projectContentDigestInput(vfs, relative, EXCLUDED));
}

/** The container side: run the shell pipeline over a real tree, exactly as the workspace does. */
function containerDigest(root: string) {
  const result = spawnSync('/bin/sh', ['-c', isolatedContentDigestCommand({ root, excludedRoots: EXCLUDED })], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function digests(name: string, files: Record<string, string>) {
  const { root, vfs } = tree(name, files);
  return { fromVfs: await vfsDigest(vfs), fromContainer: containerDigest(root) };
}

describe('project content digest', () => {
  it('agrees between the durable VFS and the copied tree', async () => {
    // The whole point: two independent computations of the same thing. If they can disagree for a
    // benign reason, the check is worthless as evidence of the malign one.
    const { fromVfs, fromContainer } = await digests('match', {
      'package.json': '{"name":"x"}',
      'src/index.ts': 'export const a = 1;\n',
      'src/routes/deep/nested.tsx': 'export default () => null;\n',
      'README.md': '# hi\n',
    });
    expect(fromContainer).toBe(fromVfs);
  });

  it('agrees for a path a checksum tool would escape', async () => {
    // `sha256sum` escapes a backslash or newline in the name and marks the line with a leading
    // `\`; the VFS side never does. A single such file used to wedge the workspace for good.
    const { fromVfs, fromContainer } = await digests('escaped', {
      'a/b\\c.txt': 'hello\n',
      'plain.txt': 'x\n',
    });
    expect(fromContainer).toBe(fromVfs);
  });

  it('diverges when a single byte of one file differs', async () => {
    // This is the #139 shape: the mount serves pre-edit content while the VFS holds the new file.
    const { root, vfs } = tree('drift', { 'src/index.ts': 'export const a = 1;\n' });
    writeFileSync(join(root, 'src/index.ts'), 'export const a = 2;\n');
    expect(containerDigest(root)).not.toBe(await vfsDigest(vfs));
  });

  it('diverges when the copy has a file the VFS does not', async () => {
    const { root, vfs } = tree('extra', { 'a.ts': 'a\n' });
    writeFileSync(join(root, 'b.ts'), 'b\n');
    expect(containerDigest(root)).not.toBe(await vfsDigest(vfs));
  });

  it('ignores build output and dependencies on both sides', async () => {
    // These exist only in the copy; counting them would make every check fail.
    const { root, vfs } = tree('excluded', { 'src/a.ts': 'a\n' });
    for (const excluded of EXCLUDED) {
      mkdirSync(join(root, excluded), { recursive: true });
      writeFileSync(join(root, excluded, 'junk'), 'junk\n');
    }
    expect(containerDigest(root)).toBe(await vfsDigest(vfs));
  });
});
