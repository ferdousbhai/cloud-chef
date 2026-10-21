import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '../../app/lib/hex-digest';
import {
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
  BUILDER_WORKSPACE_MAX_TOTAL_BYTES,
} from './protocol';

/**
 * The project's files by metadata alone, whatever their number or size.
 *
 * The workspace's limits (`BUILDER_WORKSPACE_MAX_*`) bound what its record holds: state, sync,
 * checkpoints, validation, and saved changes read every file whole. A command writes straight to the
 * container, though, so `pip install`, a large download, or a cache can leave the project over them,
 * and from then on everything reading it whole fails. What a workspace needs to get back within them
 * (its state, a deletion, and the check that the container shows the project before a cleanup
 * command runs) is answered here without that whole read, so a workspace over its limits can always
 * be recovered.
 */

/** The Computer filesystem surface used here, named structurally so it can be exercised against a fake. */
export type InventoryFilesystem = {
  find(directory: string): Promise<ReadonlyArray<{ path: string; type: 'file' | 'dir' }>>;
  stat(path: string): Promise<{ size: number; mode: number; isFile: boolean }>;
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
};

/** Where the project is, and the top-level directories its record leaves out (installed and built output). */
export type ProjectScope = { root: string; excludedRoots: ReadonlySet<string> };

export type ProjectFileStat = { path: string; size: number; mode: number };

/** Every file the project's record counts, as absolute paths, without the record's file-count limit. */
export async function enumerateProjectFiles(fs: InventoryFilesystem, scope: ProjectScope): Promise<string[]> {
  return (await fs.find(scope.root))
    .filter((entry) => entry.type === 'file' && !scope.excludedRoots.has(topLevelName(scope, entry.path)))
    .map((entry) => entry.path);
}

/** Every counted file's size and mode, from metadata alone. */
export async function projectFileStats(fs: InventoryFilesystem, scope: ProjectScope): Promise<ProjectFileStat[]> {
  const stats: ProjectFileStat[] = [];
  for (const path of await enumerateProjectFiles(fs, scope)) {
    const stat = await fs.stat(path);
    stats.push({ path, size: stat.size, mode: stat.mode });
  }
  return stats;
}

/**
 * Every counted file's SHA-256, hashed as it streams, so no file is ever held whole: the container
 * check before a command compares these with the container's own, and a cleanup command must run on
 * a project over its limits too.
 */
export async function projectFileDigests(
  fs: InventoryFilesystem,
  scope: ProjectScope,
): Promise<{ path: string; sha256: string }[]> {
  const digests: { path: string; sha256: string }[] = [];
  for (const path of await enumerateProjectFiles(fs, scope)) {
    const hash = sha256.create();
    const reader = (await fs.readFile(path)).getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      hash.update(chunk.value);
    }
    digests.push({ path, sha256: bytesToHex(hash.digest()) });
  }
  return digests;
}

/**
 * What puts these files over the workspace's limits, said for the model and for a person, or null when
 * nothing does. `situation` opens the message: the command that just ran, the workspace as it is, or a
 * change that would leave it so.
 */
export function workspaceLimitMessage(
  situation: 'command' | 'workspace' | 'change',
  files: readonly { path: string; size: number }[],
  scope: ProjectScope,
): string | null {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const oversized = files.filter((file) => file.size > BUILDER_WORKSPACE_MAX_FILE_BYTES);
  const excess: string[] = [];
  if (files.length > BUILDER_WORKSPACE_MAX_FILES) {
    excess.push(
      `${files.length.toLocaleString('en-US')} files (the limit is ${BUILDER_WORKSPACE_MAX_FILES.toLocaleString('en-US')})`,
    );
  }
  if (totalBytes > BUILDER_WORKSPACE_MAX_TOTAL_BYTES) {
    excess.push(`${mebibytes(totalBytes)} in all (the limit is ${mebibytes(BUILDER_WORKSPACE_MAX_TOTAL_BYTES)})`);
  }
  if (oversized.length > 0) {
    const named = [...oversized]
      .sort((left, right) => right.size - left.size)
      .slice(0, 3)
      .map((file) => `${relativePath(scope, file.path)} (${mebibytes(file.size)})`);
    const more = oversized.length > named.length ? ` and ${oversized.length - named.length} more` : '';
    excess.push(
      `files over the ${mebibytes(BUILDER_WORKSPACE_MAX_FILE_BYTES)} limit for one file: ${named.join(', ')}${more}`,
    );
  }
  if (excess.length === 0) {
    return null;
  }

  const byFileCount = files.length > BUILDER_WORKSPACE_MAX_FILES;
  const largest = [...topLevelTotals(files, scope)]
    .sort(([, left], [, right]) => (byFileCount ? right.files - left.files : right.bytes - left.bytes))
    .slice(0, 3)
    .map(([name, total]) => `${name} (${total.files.toLocaleString('en-US')} files, ${mebibytes(total.bytes)})`);
  const opening = {
    command: 'After this command the project workspace is over its limits',
    workspace: 'The project workspace is over its limits',
    change: 'This change would leave the project workspace over its limits',
  }[situation];
  const consequence =
    situation === 'change'
      ? 'Deleting files is always accepted.'
      : 'Until it is back within them, reading its state, saving changes, validating, and publishing fail.';
  return (
    `${opening}: ${excess.join('; ')}. The largest top-level entries are ${largest.join(', ')}. ${consequence} ` +
    'Delete what the project does not need to keep (a virtual environment, a download, a cache), for example ' +
    'with exec and `rm -rf <directory>`, or keep such files outside the project, in /tmp. ' +
    `${[...scope.excludedRoots].sort().join(', ')} do not count.`
  );
}

function topLevelTotals(
  files: readonly { path: string; size: number }[],
  scope: ProjectScope,
): Map<string, { files: number; bytes: number }> {
  const totals = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const relative = relativePath(scope, file.path);
    const slash = relative.indexOf('/');
    const name = slash < 0 ? relative : `${relative.slice(0, slash)}/`;
    const total = totals.get(name) ?? { files: 0, bytes: 0 };
    total.files += 1;
    total.bytes += file.size;
    totals.set(name, total);
  }
  return totals;
}

function topLevelName(scope: ProjectScope, path: string): string {
  return relativePath(scope, path).split('/')[0] ?? '';
}

function relativePath(scope: ProjectScope, path: string): string {
  return path.slice(scope.root.length).replace(/^\/+/, '');
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
