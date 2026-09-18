import { map, type MapStore } from 'nanostores';
import type { File, FileMap } from 'cloudchef-agent/types';
import type { AbsolutePath } from 'cloudchef-agent/utils/workDir';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceSyncEntry,
} from '~/agents/builder-workspace-types';

class WorkspaceRevisionConflictError extends Error {
  constructor(readonly state: BuilderWorkspaceApplyResult & { ok: false }) {
    super(`The project changed on another device. Reloaded durable revision ${state.state.revision}.`);
    this.name = 'WorkspaceRevisionConflictError';
  }
}

type WorkspaceChangeListener = (
  changes: BuilderWorkspaceClientChange[],
  isCurrentChange: () => boolean,
) => Promise<BuilderWorkspaceApplyResult>;

/**
 * An in-memory presentation cache of the durable BuilderAgent workspace.
 * It is always rebuildable and never executes or persists project code.
 */
export class FilesStore {
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});
  #modifiedFiles: Map<AbsolutePath, string> = import.meta.hot?.data.modifiedFiles ?? new Map();
  #workspaceChangeListener: WorkspaceChangeListener | null = null;

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
    }
  }

  getFile(filePath: AbsolutePath): File | undefined {
    const entry = this.files.get()[filePath];
    return entry?.type === 'file' ? entry : undefined;
  }

  getModifiedFiles(): Record<string, File> | undefined {
    const modifiedFiles: Record<string, File> = {};
    for (const [filePath, originalContent] of this.#modifiedFiles) {
      const file = this.getFile(filePath);
      if (file && file.content !== originalContent) {
        modifiedFiles[filePath] = file;
      }
    }
    return Object.keys(modifiedFiles).length > 0 ? modifiedFiles : undefined;
  }

  resetFileModifications(): void {
    this.#modifiedFiles.clear();
  }

  setWorkspaceChangeListener(listener: WorkspaceChangeListener | null): void {
    this.#workspaceChangeListener = listener;
  }

  clearWorkspaceChangeListener(listener: WorkspaceChangeListener): void {
    if (this.#workspaceChangeListener === listener) {
      this.#workspaceChangeListener = null;
    }
  }

  async saveFile(filePath: AbsolutePath, content: string, isCurrentEdit: () => boolean): Promise<boolean> {
    const relativePath = filePath.replace(/^\/home\/project\//, '');
    if (!relativePath || relativePath === filePath) {
      throw new Error(`Invalid durable workspace path: ${filePath}`);
    }
    assertNotLocalSecretFilePath(relativePath);
    assertValidGeneratedPackageJson(relativePath, content);
    const oldContent = this.getFile(filePath)?.content;
    if (oldContent === undefined) {
      throw new Error(`The durable workspace file no longer exists: ${filePath}`);
    }
    const workspaceChangeListener = this.#workspaceChangeListener;
    if (!workspaceChangeListener) {
      throw new Error('The durable workspace connection is not ready.');
    }

    const result = await workspaceChangeListener(
      [{ kind: 'write', path: filePath, content, encoding: 'utf8' }],
      isCurrentEdit,
    );
    if (this.#workspaceChangeListener !== workspaceChangeListener) {
      throw new Error('The active workspace changed while the file was saving.');
    }
    if (!result.ok) {
      throw new WorkspaceRevisionConflictError(result);
    }
    if (!isCurrentEdit()) {
      return false;
    }
    if (!this.#modifiedFiles.has(filePath)) {
      this.#modifiedFiles.set(filePath, oldContent);
    }
    this.files.setKey(filePath, { type: 'file', content, isBinary: false });
    return true;
  }

  applyWorkspaceSyncEntries(entries: BuilderWorkspaceSyncEntry[]): void {
    for (const entry of entries) {
      const filePath = getAbsolutePath(entry.path.replace(/^\/home\/project\/?/, ''));
      if (filePath !== entry.path) {
        throw new Error(`Invalid server workspace path: ${entry.path}`);
      }
      if (entry.kind === 'delete') {
        this.#removeTrackedPath(filePath);
        continue;
      }
      ensureParentFolders(this.files, filePath);
      this.files.setKey(filePath, {
        type: 'file',
        content: entry.encoding === 'utf8' ? entry.content : '',
        isBinary: entry.encoding === 'base64',
      });
    }
  }

  replaceWorkspaceSnapshot(entries: BuilderWorkspaceSyncEntry[], preservedPaths?: ReadonlySet<string>): void {
    const preservedFiles = Object.entries(this.files.get()).flatMap(([path, entry]) =>
      entry?.type === 'file' && preservedPaths?.has(path) ? ([[getAbsolutePath(path), entry]] as const) : [],
    );
    const preservedModifications = [...this.#modifiedFiles].filter(([path]) => preservedPaths?.has(path));

    this.files.set({});
    this.#modifiedFiles.clear();
    this.applyWorkspaceSyncEntries(
      preservedPaths ? entries.filter((entry) => !preservedPaths.has(entry.path)) : entries,
    );

    for (const [path, file] of preservedFiles) {
      ensureParentFolders(this.files, path);
      this.files.setKey(path, file);
    }
    for (const [path, originalContent] of preservedModifications) {
      this.#modifiedFiles.set(path, originalContent);
    }
  }

  stageUnsavedTextFile(filePath: AbsolutePath, content: string): void {
    ensureParentFolders(this.files, filePath);
    this.files.setKey(filePath, { type: 'file', content, isBinary: false });
  }

  #removeTrackedPath(filePath: AbsolutePath): void {
    this.files.setKey(filePath, undefined);
    const childPrefix = `${filePath}/`;
    for (const candidatePath of Object.keys(this.files.get())) {
      if (candidatePath.startsWith(childPrefix)) {
        this.files.setKey(getAbsolutePath(candidatePath), undefined);
      }
    }
    for (const candidatePath of this.#modifiedFiles.keys()) {
      if (candidatePath === filePath || candidatePath.startsWith(childPrefix)) {
        this.#modifiedFiles.delete(candidatePath);
      }
    }
  }
}

function ensureParentFolders(files: MapStore<FileMap>, filePath: AbsolutePath): void {
  const segments = filePath.split('/');
  for (let index = 3; index < segments.length; index += 1) {
    const folder = getAbsolutePath(segments.slice(0, index).join('/'));
    if (!files.get()[folder]) {
      files.setKey(folder, { type: 'folder' });
    }
  }
}
