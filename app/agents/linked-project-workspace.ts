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

/** A new key for a workspace's own branch on GitHub (see `BuilderWorkspaceLinkedProject.branchKey`). */
export function newLinkedBranchKey(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/**
 * Seeds a workspace from a GitHub project's default branch, streamed from the control plane, and records
 * the commit and each file's hash, so later changes can be told from what GitHub has. Batches go in as
 * they arrive: a repository never sits in the agent's memory whole.
 */
export async function seedLinkedWorkspace(
  workspace: Pick<
    BuilderWorkspaceApi,
    'beginSeed' | 'appendSeed' | 'commitSeed' | 'abortSeed' | 'setLinkedProject' | 'linkedProject'
  >,
  orgProjectId: string,
  lines: AsyncIterable<LinkedSnapshotLine>,
): Promise<BuilderWorkspaceState> {
  const seedId = `linked_${orgProjectId}`;
  const started = await workspace.beginSeed(seedId);
  if (started.status === 'initialized') {
    // Seeded and linked together: a seeded workspace without its link would quietly lose GitHub.
    if (!(await workspace.linkedProject())) {
      throw new Error('This workspace lost track of its GitHub project. Open the project again from the menu.');
    }
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
      manifest.push({ path: line.path, sha256: await sha256Hex(bytes), executable: line.executable });
      totalBytes += bytes.length;
      // GitHub's mode goes in with the file, so the workspace's own modes are the repository's.
      const entry = {
        path: `${WORK_DIR}/${line.path}`,
        content: line.contentBase64,
        encoding: 'base64' as const,
        mode: line.executable ? 0o755 : 0o644,
      };
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
    // Linked before the seed commits, so a workspace is never initialized without its project.
    await workspace.setLinkedProject({
      orgProjectId,
      repository: head.repository,
      defaultBranch: head.defaultBranch,
      baseCommit: head.commit,
      baseManifest: manifest,
      branchKey: newLinkedBranchKey(),
      workspaceModes: true,
    });
    return await workspace.commitSeed(seedId, { fileCount: manifest.length, totalBytes });
  } catch (error) {
    await workspace.abortSeed(seedId).catch(() => undefined);
    throw error;
  }
}

/**
 * The workspace's changes against its base commit: every file whose content or executable bit differs or
 * is new, and every file that's gone. This is exactly what GitHub needs to show the workspace as it is.
 * Also returns the workspace's own manifest, which becomes the base once the changes are merged.
 */
export async function linkedWorkspaceChanges(
  workspace: Pick<BuilderWorkspaceApi, 'refresh' | 'listFiles' | 'readFile'>,
  linked: BuilderWorkspaceLinkedProject,
): Promise<{ changes: LinkedChange[]; manifest: BuilderWorkspaceLinkedProject['baseManifest'] }> {
  const base = new Map(linked.baseManifest.map((file) => [file.path, file]));
  await workspace.refresh();
  const current = workspace
    .listFiles()
    .filter((file) => !EXCLUDED_ROOTS.has(projectPath(file.path).split('/')[0] ?? ''));
  const changes: LinkedChange[] = [];
  const manifest: BuilderWorkspaceLinkedProject['baseManifest'] = [];
  const present = new Set<string>();
  for (const file of current) {
    const path = projectPath(file.path);
    present.add(path);
    const before = base.get(path);
    // A workspace seeded before it kept GitHub's modes holds every file as non-executable, so there an
    // executable at the base stays one: only a workspace with GitHub's modes can tell a removed bit.
    const executable = (file.mode & 0o111) !== 0 || (!linked.workspaceModes && before?.executable === true);
    manifest.push({ path, sha256: file.sha256, executable });
    if (before?.sha256 === file.sha256 && (before.executable ?? false) === executable) {
      continue;
    }
    const read = await workspace.readFile(file.path);
    changes.push({ path, contentBase64: bytesToBase64(read.bytes), executable });
  }
  for (const path of base.keys()) {
    if (!present.has(path)) {
      changes.push({ path, contentBase64: null, executable: false });
    }
  }
  return { changes, manifest };
}

function projectPath(path: string): string {
  return path.startsWith(`${WORK_DIR}/`) ? path.slice(WORK_DIR.length + 1) : path;
}

/**
 * A draft's files at its current revision, as the gzipped JSON a production request carries
 * (`[{ path, contentBase64 }]`, base64): read page by page from the workspace's own sync feed.
 */
export async function packDraftSnapshot(
  workspace: Pick<BuilderWorkspaceApi, 'getSyncPage'>,
): Promise<{ snapshot: string; files: number }> {
  let files: { path: string; contentBase64: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await workspace.getSyncPage(cursor ? { fromRevision: 0, cursor } : { fromRevision: 0 });
    if (page.restart) {
      files = [];
      cursor = undefined;
      continue;
    }
    for (const entry of page.entries) {
      const path = projectPath(entry.path);
      if (entry.kind !== 'write' || EXCLUDED_ROOTS.has(path.split('/')[0] ?? '')) {
        continue;
      }
      files.push({
        path,
        contentBase64:
          entry.encoding === 'base64' ? entry.content : bytesToBase64(new TextEncoder().encode(entry.content)),
      });
    }
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  const compressed = new Blob([JSON.stringify(files)]).stream().pipeThrough(new CompressionStream('gzip'));
  return { snapshot: bytesToBase64(new Uint8Array(await new Response(compressed).arrayBuffer())), files: files.length };
}
