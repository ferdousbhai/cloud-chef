import { WORK_DIR } from 'cloudchef-agent/constants';
import type { LinkedSnapshotLine } from '~/lib/.server/cloudflare/linked-project-client';
import { bytesToBase64, sha256Hex } from '~/lib/hex-digest';
import type { BuilderWorkspaceApi } from './builder-workspace-api';
import {
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
  type BuilderWorkspaceFileInput,
  type BuilderWorkspaceLinkedProject,
  type BuilderWorkspaceState,
} from './builder-workspace-types';

/** What the workspace keeps out of its own record (user-workspace-runtime/src/index.ts), skipped here too. */
const EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler', '.cloudflare']);

/** One file change for GitHub: new or changed content, or `null` to delete it. */
type LinkedChange = { path: string; contentBase64: string | null; executable: boolean };

/**
 * Seeds a workspace from a GitHub project's default branch, streamed from the control plane, and records
 * the commit and each file's hash, so later changes can be told from what GitHub has. Batches go in as
 * they arrive: a repository never sits in the agent's memory whole.
 */
export async function seedLinkedWorkspace(
  workspace: BuilderWorkspaceApi,
  orgProjectId: string,
  lines: AsyncIterable<LinkedSnapshotLine>,
): Promise<BuilderWorkspaceState> {
  const seedId = `linked_${orgProjectId}`;
  const started = await workspace.beginSeed(seedId);
  if (started.status === 'initialized') {
    return started.state;
  }
  try {
    let head: { commit: string; defaultBranch: string; repository: string } | null = null;
    const manifest: BuilderWorkspaceLinkedProject['baseManifest'] = [];
    let batch: BuilderWorkspaceFileInput[] = [];
    let batchCharacters = 0;
    let totalBytes = 0;
    let complete = false;
    for await (const line of lines) {
      if ('error' in line) {
        throw new Error(line.error);
      }
      if ('commit' in line) {
        head = line;
        continue;
      }
      if ('done' in line) {
        complete = true;
        break;
      }
      if (EXCLUDED_ROOTS.has(line.path.split('/')[0] ?? '')) {
        continue;
      }
      const bytes = Uint8Array.from(atob(line.contentBase64), (char) => char.charCodeAt(0));
      manifest.push({ path: line.path, sha256: await sha256Hex(bytes) });
      totalBytes += bytes.length;
      const entry = { path: `${WORK_DIR}/${line.path}`, content: line.contentBase64, encoding: 'base64' as const };
      if (
        batch.length >= BUILDER_WORKSPACE_SYNC_BATCH_FILES ||
        batchCharacters + entry.content.length > BUILDER_WORKSPACE_SYNC_BATCH_BYTES * 6
      ) {
        await workspace.appendSeed(seedId, batch);
        batch = [];
        batchCharacters = 0;
      }
      batch.push(entry);
      batchCharacters += entry.path.length + entry.content.length;
    }
    if (!head || !complete) {
      throw new Error('The project download from GitHub ended early. Open the project again.');
    }
    if (batch.length > 0) {
      await workspace.appendSeed(seedId, batch);
    }
    const state = await workspace.commitSeed(seedId, { fileCount: manifest.length, totalBytes });
    await workspace.setLinkedProject({
      orgProjectId,
      repository: head.repository,
      defaultBranch: head.defaultBranch,
      baseCommit: head.commit,
      baseManifest: manifest,
    });
    return state;
  } catch (error) {
    await workspace.abortSeed(seedId).catch(() => undefined);
    throw error;
  }
}

/**
 * The workspace's changes against the commit it was opened from: every file whose content differs or is
 * new, and every file that's gone. This is exactly what GitHub needs to show the workspace as it is.
 */
export async function linkedWorkspaceChanges(
  workspace: BuilderWorkspaceApi,
  linked: BuilderWorkspaceLinkedProject,
): Promise<LinkedChange[]> {
  const base = new Map(linked.baseManifest.map((file) => [file.path, file.sha256]));
  await workspace.refresh();
  const current = workspace
    .listFiles()
    .filter((file) => !EXCLUDED_ROOTS.has(projectPath(file.path).split('/')[0] ?? ''));
  const changes: LinkedChange[] = [];
  const present = new Set<string>();
  for (const file of current) {
    const path = projectPath(file.path);
    present.add(path);
    if (base.get(path) === file.sha256) {
      continue;
    }
    const read = await workspace.readFile(file.path);
    changes.push({ path, contentBase64: bytesToBase64(read.bytes), executable: (file.mode & 0o111) !== 0 });
  }
  for (const path of base.keys()) {
    if (!present.has(path)) {
      changes.push({ path, contentBase64: null, executable: false });
    }
  }
  return changes;
}

function projectPath(path: string): string {
  return path.startsWith(`${WORK_DIR}/`) ? path.slice(WORK_DIR.length + 1) : path;
}
