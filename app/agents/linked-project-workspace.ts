import { WORK_DIR } from 'cloudchef-agent/constants';
import { base64ToBytes, bytesToBase64, sha256Hex } from '~/lib/hex-digest';
import type { ProjectRepositories, RepositoryFileInput } from '~/lib/.server/cloudflare/project-repository';
import { ProjectRefusalError } from '~/lib/.server/cloudflare/linked-project-client';
import { MAIN_BRANCH } from '~/lib/.server/cloudflare/project-repository';
import type { BuilderWorkspaceApi } from './builder-workspace-api';
import { readWholeSyncFeed, seedBatches } from './builder-workspace-seed';
import { gitignoreMatcher, isNeverPublished } from './linked-project-ignore';
import type {
  BuilderWorkspaceClientChange,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceState,
} from '@cloudchef/user-workspace-runtime/protocol';

/** What the workspace keeps out of its own record (user-workspace-runtime/src/index.ts), skipped here too. */
const EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler', '.cloudflare', '.venv']);

/** Whether a project path is installed or built output, which no commit, seed or revert takes. */
export function isExcludedProjectPath(path: string): boolean {
  return EXCLUDED_ROOTS.has(path.split('/')[0] ?? '');
}

/** The project a workspace is seeded from: the control plane's record of it, with its repository. */
type SeedProject = { orgProjectId: string; name: string; repo: string };

/**
 * Seeds a workspace from main of a project's repository, and records the commit, which git in the workspace
 * starts from. Files go in as they are read: a repository never sits in the agent's memory whole.
 */
export async function seedLinkedWorkspace(
  workspace: Pick<
    BuilderWorkspaceApi,
    'beginSeed' | 'appendSeed' | 'commitSeed' | 'abortSeed' | 'setLinkedProject' | 'linkedProject'
  >,
  repositories: Pick<ProjectRepositories, 'streamFilesAt'>,
  project: SeedProject,
): Promise<BuilderWorkspaceState> {
  const seedId = `linked_${project.orgProjectId}`;
  const started = await workspace.beginSeed(seedId);
  if (started.status === 'initialized') {
    // Seeded and linked together: a seeded workspace without its link would quietly lose its project.
    if (!(await workspace.linkedProject())) {
      throw new ProjectRefusalError('This workspace lost track of its project. Open the project again from the menu.');
    }
    return started.state;
  }
  try {
    const { commit, files } = await repositories.streamFilesAt(
      project.repo,
      MAIN_BRANCH,
      (path) => !isExcludedProjectPath(path),
    );
    let fileCount = 0;
    let totalBytes = 0;
    async function* entries(): AsyncGenerator<BuilderWorkspaceFileInput> {
      for await (const file of files) {
        const executable = file.mode === '100755';
        fileCount += 1;
        totalBytes += file.bytes.length;
        // The repository's mode goes in with the file, so the workspace's own modes are the repository's.
        yield {
          path: `${WORK_DIR}/${file.path}`,
          content: bytesToBase64(file.bytes),
          encoding: 'base64',
          mode: executable ? 0o755 : 0o644,
        };
      }
    }
    for await (const batch of seedBatches(entries())) {
      await workspace.appendSeed(seedId, batch);
    }
    // Linked before the seed commits, so a workspace is never initialized without its project.
    await workspace.setLinkedProject({
      orgProjectId: project.orgProjectId,
      repository: project.repo,
      name: project.name,
      defaultBranch: MAIN_BRANCH,
      baseCommit: commit.hash,
    });
    return await workspace.commitSeed(seedId, { fileCount, totalBytes });
  } catch (error) {
    await workspace.abortSeed(seedId).catch(() => undefined);
    throw error;
  }
}

/**
 * The workspace as a commit of it holds it, read page by page from its own sync feed, and the revision it
 * was read at: every file but installed and built output, and, unless the repository already tracks them,
 * local secrets and what its `.gitignore` files ignore. Null when the workspace kept changing under the read.
 */
export async function workspaceCommitFiles(
  workspace: Pick<BuilderWorkspaceApi, 'getSyncPage'>,
  /** Paths the repository already tracks, which stay whatever `.gitignore` or the secrets rule say, as in git. */
  tracked: ReadonlySet<string> = new Set(),
): Promise<{ files: RepositoryFileInput[]; targetRevision: number } | null> {
  const feed = await readWholeSyncFeed((request) => workspace.getSyncPage(request));
  if (!feed) {
    return null;
  }
  const files: RepositoryFileInput[] = [];
  const gitignores: { path: string; content: string }[] = [];
  for (const entry of feed.files) {
    const path = projectPath(entry.path);
    if (isExcludedProjectPath(path) || (isNeverPublished(path) && !tracked.has(path))) {
      continue;
    }
    const bytes = entry.encoding === 'base64' ? base64ToBytes(entry.content) : new TextEncoder().encode(entry.content);
    if (isGitignore(path)) {
      gitignores.push({ path, content: new TextDecoder().decode(bytes) });
    }
    files.push({ path, mode: entry.mode ?? 0o644, bytes });
  }
  const ignored = gitignoreMatcher(gitignores);
  return {
    files: files.filter((file) => tracked.has(file.path) || !ignored(file.path)),
    targetRevision: feed.targetRevision,
  };
}

/**
 * The change set that makes the workspace hold exactly a commit's files: each that differs written, and
 * each the commit lacks deleted, except what no commit holds (installed and built output, local secrets,
 * and files the workspace's or the commit's `.gitignore` files ignore), which stays as it is.
 */
export async function revertChanges(
  workspace: Pick<BuilderWorkspaceApi, 'refresh' | 'listFiles' | 'readFile'>,
  commitFiles: readonly { path: string; mode: string; bytes: Uint8Array<ArrayBuffer> }[],
): Promise<{ baseRevision: number; changes: BuilderWorkspaceClientChange[] }> {
  const state = await workspace.refresh();
  const current = workspace.listFiles().filter((file) => !isExcludedProjectPath(projectPath(file.path)));
  const gitignores = [
    ...(await workspaceGitignores(workspace, current)),
    ...commitFiles
      .filter((file) => isGitignore(file.path))
      .map((file) => ({ path: file.path, content: new TextDecoder().decode(file.bytes) })),
  ];
  const ignored = gitignoreMatcher(gitignores);
  const existing = new Map(current.map((file) => [projectPath(file.path), file]));
  const changes: BuilderWorkspaceClientChange[] = [];
  const wanted = new Set<string>();
  for (const file of commitFiles) {
    wanted.add(file.path);
    const mode = file.mode === '100755' ? 0o755 : 0o644;
    const now = existing.get(file.path);
    if (now && now.sha256 === (await sha256Hex(file.bytes)) && (now.mode & 0o111) === (mode & 0o111)) {
      continue;
    }
    changes.push({
      kind: 'write',
      path: `${WORK_DIR}/${file.path}`,
      content: bytesToBase64(file.bytes),
      encoding: 'base64',
      mode,
    });
  }
  for (const path of existing.keys()) {
    if (!wanted.has(path) && !isNeverPublished(path) && !ignored(path)) {
      changes.push({ kind: 'delete', path: `${WORK_DIR}/${path}` });
    }
  }
  return { baseRevision: state.revision, changes };
}

async function workspaceGitignores(
  workspace: Pick<BuilderWorkspaceApi, 'readFile'>,
  files: readonly { path: string }[],
): Promise<{ path: string; content: string }[]> {
  return Promise.all(
    files
      .filter((file) => isGitignore(projectPath(file.path)))
      .map(async (file) => ({
        path: projectPath(file.path),
        content: new TextDecoder().decode((await workspace.readFile(file.path)).bytes),
      })),
  );
}

function isGitignore(path: string): boolean {
  return path === '.gitignore' || path.endsWith('/.gitignore');
}

function projectPath(path: string): string {
  return path.startsWith(`${WORK_DIR}/`) ? path.slice(WORK_DIR.length + 1) : path;
}
