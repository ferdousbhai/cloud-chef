import { WORK_DIR } from 'cloudchef-agent/constants';
import type { LinkedSnapshotLine } from '~/lib/.server/cloudflare/linked-project-client';
import { bytesToBase64, sha256Hex } from '~/lib/hex-digest';
import type { BuilderWorkspaceApi } from './builder-workspace-api';
import { readWholeSyncFeed, seedBatches } from './builder-workspace-seed';
import { gitignoreMatcher, isNeverPublished } from './linked-project-ignore';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
} from './builder-workspace-types';

/** What the workspace keeps out of its own record (user-workspace-runtime/src/index.ts), skipped here too. */
const EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler', '.cloudflare', '.venv']);

/** One file change for GitHub: new or changed content, or `null` to delete it. */
type LinkedChange = { path: string; contentBase64: string | null; executable: boolean };

/** What a GitHub snapshot download reported, filled in as its files are read. */
type SnapshotDownload = {
  head: { commit: string; defaultBranch: string; repository: string } | null;
  complete: boolean;
  totalBytes: number;
};

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
    const download: SnapshotDownload = { head: null, complete: false, totalBytes: 0 };
    const manifest: BuilderWorkspaceLinkedProject['baseManifest'] = [];
    async function* files(): AsyncGenerator<BuilderWorkspaceFileInput> {
      for await (const line of lines) {
        if ('error' in line) {
          throw new Error(line.error);
        }
        if ('commit' in line) {
          download.head = line;
          continue;
        }
        if ('done' in line) {
          download.complete = true;
          return;
        }
        if (EXCLUDED_ROOTS.has(line.path.split('/')[0] ?? '')) {
          continue;
        }
        const bytes = Uint8Array.from(atob(line.contentBase64), (char) => char.charCodeAt(0));
        manifest.push({ path: line.path, sha256: await sha256Hex(bytes), executable: line.executable });
        download.totalBytes += bytes.length;
        // GitHub's mode goes in with the file, so the workspace's own modes are the repository's.
        yield {
          path: `${WORK_DIR}/${line.path}`,
          content: line.contentBase64,
          encoding: 'base64',
          mode: line.executable ? 0o755 : 0o644,
        };
      }
    }
    for await (const batch of seedBatches(files())) {
      await workspace.appendSeed(seedId, batch);
    }
    const { head, complete, totalBytes } = download;
    if (!head || !complete) {
      throw new Error('The project download from GitHub ended early. Open the project again.');
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
 * As in git, a new file the project's `.gitignore` files ignore is left out (one GitHub already has is
 * sent whether or not it is ignored), and local secrets (`isNeverPublished`) never go, either way: those
 * edited, removed, or new and not ignored come back as `heldBack`, for the model to tell the person.
 * Also returns the workspace's own manifest, which becomes the base once the changes are merged.
 */
export async function linkedWorkspaceChanges(
  workspace: Pick<BuilderWorkspaceApi, 'refresh' | 'listFiles' | 'readFile'>,
  linked: BuilderWorkspaceLinkedProject,
): Promise<{
  changes: LinkedChange[];
  manifest: BuilderWorkspaceLinkedProject['baseManifest'];
  heldBack: string[];
}> {
  const base = new Map(linked.baseManifest.map((file) => [file.path, file]));
  await workspace.refresh();
  const current = workspace
    .listFiles()
    .filter((file) => !EXCLUDED_ROOTS.has(projectPath(file.path).split('/')[0] ?? ''));
  const gitignores = await Promise.all(
    current
      .filter((file) => isGitignore(projectPath(file.path)))
      .map(async (file) => ({
        path: projectPath(file.path),
        content: new TextDecoder().decode((await workspace.readFile(file.path)).bytes),
      })),
  );
  const ignored = gitignoreMatcher(gitignores);
  const changes: LinkedChange[] = [];
  const heldBack: string[] = [];
  // A secret GitHub has stays as GitHub has it: neither its edit nor its removal is sent.
  const manifest: BuilderWorkspaceLinkedProject['baseManifest'] = linked.baseManifest.filter((file) =>
    isNeverPublished(file.path),
  );
  const present = new Set<string>();
  for (const file of current) {
    const path = projectPath(file.path);
    const before = base.get(path);
    if (!before && ignored(path)) {
      continue;
    }
    if (isNeverPublished(path)) {
      present.add(path);
      if (before?.sha256 !== file.sha256) {
        heldBack.push(path);
      }
      continue;
    }
    present.add(path);
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
    if (present.has(path)) {
      continue;
    }
    if (isNeverPublished(path)) {
      heldBack.push(path);
    } else {
      changes.push({ path, contentBase64: null, executable: false });
    }
  }
  return { changes, manifest, heldBack };
}

function isGitignore(path: string): boolean {
  return path === '.gitignore' || path.endsWith('/.gitignore');
}

function projectPath(path: string): string {
  return path.startsWith(`${WORK_DIR}/`) ? path.slice(WORK_DIR.length + 1) : path;
}

/**
 * A draft's files at its current revision, as the gzipped JSON a production request carries
 * (`[{ path, contentBase64 }]`, base64): read page by page from the workspace's own sync feed. The draft
 * becomes a new repository's first commit, so every file is new to git: what its `.gitignore` files
 * ignore, and local secrets, are left out.
 */
export async function packDraftSnapshot(
  workspace: Pick<BuilderWorkspaceApi, 'getSyncPage'>,
): Promise<{ snapshot: string; files: number }> {
  const feed = await readWholeSyncFeed((request) => workspace.getSyncPage(request));
  if (!feed) {
    throw new Error('The draft kept changing while it was being read. Try again.');
  }
  let files: { path: string; contentBase64: string }[] = [];
  const gitignores: { path: string; content: string }[] = [];
  for (const entry of feed.files) {
    const path = projectPath(entry.path);
    if (EXCLUDED_ROOTS.has(path.split('/')[0] ?? '') || isNeverPublished(path)) {
      continue;
    }
    if (isGitignore(path)) {
      gitignores.push({
        path,
        content:
          entry.encoding === 'base64'
            ? new TextDecoder().decode(Uint8Array.from(atob(entry.content), (char) => char.charCodeAt(0)))
            : entry.content,
      });
    }
    files.push({
      path,
      contentBase64:
        entry.encoding === 'base64' ? entry.content : bytesToBase64(new TextEncoder().encode(entry.content)),
    });
  }
  const ignored = gitignoreMatcher(gitignores);
  files = files.filter((file) => !ignored(file.path));
  const compressed = new Blob([JSON.stringify(files)]).stream().pipeThrough(new CompressionStream('gzip'));
  return { snapshot: bytesToBase64(new Uint8Array(await new Response(compressed).arrayBuffer())), files: files.length };
}
