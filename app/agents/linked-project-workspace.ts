import { WORK_DIR } from 'cloudchef-agent/constants';
import { base64ToBytes, bytesToBase64, sha256Hex } from '~/lib/hex-digest';
import type {
  ProjectRepositories,
  RepositoryFileInput,
  RepositoryTreeFile,
} from '~/lib/.server/cloudflare/project-repository';
import { MAIN_BRANCH } from '~/lib/.server/cloudflare/project-repository';
import type { BuilderWorkspaceApi } from './builder-workspace-api';
import { readWholeSyncFeed, seedBatches } from './builder-workspace-seed';
import { gitignoreMatcher, isNeverPublished } from './linked-project-ignore';
import type {
  BuilderWorkspaceClientChange,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
} from '@cloudchef/user-workspace-runtime/protocol';

/** What the workspace keeps out of its own record (user-workspace-runtime/src/index.ts), skipped here too. */
const EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler', '.cloudflare', '.venv']);

/** Whether a project path is installed or built output, which no commit, seed or revert takes. */
export function isExcludedProjectPath(path: string): boolean {
  return EXCLUDED_ROOTS.has(path.split('/')[0] ?? '');
}

/** One file change against the base commit: new or changed bytes, or `null` to delete it. */
type LinkedChange = { path: string; bytes: Uint8Array | null; executable: boolean };

/** A new key for a workspace's own branch (see `BuilderWorkspaceLinkedProject.branchKey`). */
export function newLinkedBranchKey(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/**
 * The workspace's own branch: the member's email's name part, made safe for git, then the workspace's key.
 * Without a key (a workspace opened before branches were per conversation), the member's one branch.
 */
export function memberBranch(email: string | null, userId: string, branchKey: string | undefined): string {
  const name = (email?.split('@')[0] ?? 'member')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const member = `cloudchef/${name || 'member'}-${userId
    .slice(0, 6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0')}`;
  return branchKey ? `${member}-${branchKey}` : member;
}

/** The project a workspace is seeded from: the control plane's record of it, with its repository. */
type SeedProject = { orgProjectId: string; name: string; repo: string };

/**
 * Seeds a workspace from main of a project's repository, and records the commit and each file's hash, so
 * later changes can be told from what the repository has. Files go in as they are read: a repository never
 * sits in the agent's memory whole.
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
      throw new Error('This workspace lost track of its project. Open the project again from the menu.');
    }
    return started.state;
  }
  try {
    const { commit, files } = await repositories.streamFilesAt(
      project.repo,
      MAIN_BRANCH,
      (path) => !isExcludedProjectPath(path),
    );
    const manifest: BuilderWorkspaceLinkedProject['baseManifest'] = [];
    let totalBytes = 0;
    async function* entries(): AsyncGenerator<BuilderWorkspaceFileInput> {
      for await (const file of files) {
        const executable = file.mode === '100755';
        manifest.push({ path: file.path, sha256: await sha256Hex(file.bytes), executable });
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
 * is new, and every file that's gone. As in git, a new file the project's `.gitignore` files ignore is left
 * out (one the repository already has is sent whether or not it is ignored), and local secrets
 * (`isNeverPublished`) never go, either way: those edited, removed, or new and not ignored come back as
 * `heldBack`, for the model to tell the person. Also returns the workspace's own manifest, which becomes
 * the base once the changes are merged.
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
  const current = workspace.listFiles().filter((file) => !isExcludedProjectPath(projectPath(file.path)));
  const ignored = gitignoreMatcher(await workspaceGitignores(workspace, current));
  const changes: LinkedChange[] = [];
  const heldBack: string[] = [];
  // A secret the repository has stays as it has it: neither its edit nor its removal is sent.
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
    // A workspace seeded before it kept the repository's modes holds every file as non-executable, so
    // there an executable at the base stays one: only a workspace with the modes can tell a removed bit.
    const executable = (file.mode & 0o111) !== 0 || (!linked.workspaceModes && before?.executable === true);
    manifest.push({ path, sha256: file.sha256, executable });
    if (before?.sha256 === file.sha256 && (before.executable ?? false) === executable) {
      continue;
    }
    const read = await workspace.readFile(file.path);
    changes.push({ path, bytes: read.bytes, executable });
  }
  for (const path of base.keys()) {
    if (present.has(path)) {
      continue;
    }
    if (isNeverPublished(path)) {
      heldBack.push(path);
    } else {
      changes.push({ path, bytes: null, executable: false });
    }
  }
  return { changes, manifest, heldBack };
}

/**
 * The whole tree a commit of the workspace writes: the base commit's tree with the changes applied.
 * Files the change leaves alone are named by the blob the repository already has, so only changed
 * files are sent.
 */
export function linkedCommitTree(
  base: readonly RepositoryTreeFile[],
  changes: readonly LinkedChange[],
): RepositoryFileInput[] {
  const tree = new Map<string, RepositoryFileInput>(
    base
      .filter((file) => file.mode === '100644' || file.mode === '100755')
      .map((file) => [file.path, { path: file.path, mode: file.mode === '100755' ? 0o755 : 0o644, oid: file.oid }]),
  );
  for (const change of changes) {
    if (change.bytes === null) {
      tree.delete(change.path);
    } else {
      tree.set(change.path, { path: change.path, mode: change.executable ? 0o755 : 0o644, bytes: change.bytes });
    }
  }
  return [...tree.values()];
}

/**
 * The workspace as a commit of it holds it, read page by page from its own sync feed, and the revision it
 * was read at: every file but installed and built output, local secrets, and what its `.gitignore` files
 * ignore (every file is new to a commit made this way). Null when the workspace kept changing under the read.
 */
export async function workspaceCommitFiles(
  workspace: Pick<BuilderWorkspaceApi, 'getSyncPage'>,
): Promise<{ files: RepositoryFileInput[]; targetRevision: number } | null> {
  const feed = await readWholeSyncFeed((request) => workspace.getSyncPage(request));
  if (!feed) {
    return null;
  }
  const files: RepositoryFileInput[] = [];
  const gitignores: { path: string; content: string }[] = [];
  for (const entry of feed.files) {
    const path = projectPath(entry.path);
    if (isExcludedProjectPath(path) || isNeverPublished(path)) {
      continue;
    }
    const bytes = entry.encoding === 'base64' ? base64ToBytes(entry.content) : new TextEncoder().encode(entry.content);
    if (isGitignore(path)) {
      gitignores.push({ path, content: new TextDecoder().decode(bytes) });
    }
    files.push({ path, mode: entry.mode ?? 0o644, bytes });
  }
  const ignored = gitignoreMatcher(gitignores);
  return { files: files.filter((file) => !ignored(file.path)), targetRevision: feed.targetRevision };
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
