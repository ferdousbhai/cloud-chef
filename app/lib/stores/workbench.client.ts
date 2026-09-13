import { atom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, File, FileMap, ScrollPosition } from 'ghostbuild-agent/types';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceSyncEntry,
} from '~/agents/builder-workspace-types';
import { downloadProject } from '~/lib/download/download-project';
import { description } from './description';
import { EditorStore } from './editor';
import { FilesStore } from './files';
import { PreviewsStore } from './previews';
import { workbenchCurrentView } from './workbench-ui-state';

/** Editor buffers that differ from what is on disk and are renderable as text. */
type UnsavedTextFiles = Record<AbsolutePath, File>;

export type { WorkbenchViewType } from './workbench-ui-state';

type WorkspaceChangeListener = (
  changes: BuilderWorkspaceClientChange[],
  isCurrentChange: () => boolean,
) => Promise<BuilderWorkspaceApplyResult>;

export class WorkbenchStore {
  #previewsStore = new PreviewsStore();
  #filesStore = new FilesStore();
  #editorStore = new EditorStore();
  #flushPendingEditorChange: (() => void) | null = null;
  #workspaceId: string | null = null;
  #workspaceGeneration = 0;
  #editVersions = new Map<AbsolutePath, number>();
  #pendingSaveCounts = new Map<AbsolutePath, number>();
  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView = workbenchCurrentView;
  unsavedFiles: WritableAtom<Set<AbsolutePath>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<AbsolutePath>());

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
    }
  }

  get followingStreamedCode() {
    return this.#editorStore.followingStreamedCode;
  }

  get previewState() {
    return this.#previewsStore.state;
  }

  connectPreview(...args: Parameters<PreviewsStore['connect']>) {
    return this.#previewsStore.connect(...args);
  }

  updatePreview(...args: Parameters<PreviewsStore['update']>) {
    return this.#previewsStore.update(...args);
  }

  get publicationState() {
    return this.#previewsStore.publication;
  }

  updatePublication(...args: Parameters<PreviewsStore['updatePublication']>) {
    return this.#previewsStore.updatePublication(...args);
  }

  requestPreview(...args: Parameters<PreviewsStore['request']>) {
    return this.#previewsStore.request(...args);
  }

  get files() {
    return this.#filesStore.files;
  }

  setWorkspaceChangeListener(listener: WorkspaceChangeListener | null): void {
    this.#filesStore.setWorkspaceChangeListener(listener);
  }

  clearWorkspaceChangeListener(listener: WorkspaceChangeListener): void {
    this.#filesStore.clearWorkspaceChangeListener(listener);
  }

  registerPendingEditorChangeFlusher(flush: () => void): () => void {
    this.#flushPendingEditorChange = flush;
    return () => {
      if (this.#flushPendingEditorChange === flush) {
        this.#flushPendingEditorChange = null;
      }
    };
  }

  flushPendingEditorChange(): void {
    this.#flushPendingEditorChange?.();
  }

  activateWorkspace(workspaceId: string): void {
    if (this.#workspaceId === workspaceId) {
      return;
    }
    this.#workspaceId = workspaceId;
    this.#workspaceGeneration += 1;
    // The flusher belongs to the mounted editor, not to the workspace: the editor survives a
    // workspace switch and re-registers nothing, so clearing it here left every later flush a
    // no-op and silently dropped the editor's buffered keystrokes for the rest of the page's life.
    // Its own unregister closure tears it down when the editor unmounts.
    this.#editVersions.clear();
    this.#pendingSaveCounts.clear();
    this.#filesStore.setWorkspaceChangeListener(null);
    this.unsavedFiles.set(new Set());
    this.#filesStore.replaceWorkspaceSnapshot([]);
    this.#editorStore.setDocuments({});
    this.#editorStore.setSelectedFile(undefined);
    this.#editorStore.followingStreamedCode.set(true);
    this.#previewsStore.reset();
    this.currentView.set('code');
    this.showWorkbench.set(false);
  }

  getActiveWorkspaceId(): string | null {
    return this.#workspaceId;
  }

  isWorkspaceActive(workspaceId: string): boolean {
    return this.#workspaceId === workspaceId;
  }

  applyWorkspaceSyncEntries(entries: BuilderWorkspaceSyncEntry[]): void {
    this.flushPendingEditorChange();
    this.#filesStore.applyWorkspaceSyncEntries(entries);
    this.setDocuments(this.#filesStore.files.get());
  }

  replaceWorkspaceSnapshot(entries: BuilderWorkspaceSyncEntry[], preservedPaths?: ReadonlySet<string>): void {
    this.flushPendingEditorChange();

    const unsavedFiles = this.unsavedFiles.get();
    const unsavedDocuments = new Map(
      [...unsavedFiles]
        .map((filePath) => [filePath, this.#editorStore.documents.get()[filePath]] as const)
        .filter(
          (entry): entry is readonly [AbsolutePath, EditorDocument] => entry[1] !== undefined && !entry[1].isBinary,
        ),
    );

    this.#filesStore.replaceWorkspaceSnapshot(entries, preservedPaths);

    const durableFiles = this.#filesStore.files.get();
    const nextUnsavedFiles = new Set<AbsolutePath>();

    for (const [filePath, document] of unsavedDocuments) {
      const durableFile = durableFiles[filePath];
      if (durableFile?.type === 'file' && !durableFile.isBinary) {
        if (durableFile.content !== document.value || preservedPaths?.has(filePath)) {
          nextUnsavedFiles.add(filePath);
        }
        continue;
      }

      // A full snapshot can race a local edit with a remote deletion. Keep the
      // local text as an unsaved recreation instead of silently discarding it.
      this.#filesStore.stageUnsavedTextFile(filePath, document.value);
      nextUnsavedFiles.add(filePath);
    }

    this.unsavedFiles.set(nextUnsavedFiles);
    this.setDocuments(this.#filesStore.files.get());
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  setDocuments(files: FileMap): void {
    this.flushPendingEditorChange();
    this.#editorStore.setDocuments(files, this.unsavedFiles.get());
    if (this.currentDocument.get() !== undefined) {
      return;
    }
    const preferredFiles = ['/home/project/src/routes/index.tsx', '/home/project/package.json'].map(getAbsolutePath);
    const preferredFile = preferredFiles.find((filePath) => files[filePath]?.type === 'file');
    if (preferredFile) {
      this.setSelectedFile(preferredFile);
      return;
    }
    const firstFile = Object.entries(files).find(([, entry]) => entry?.type === 'file');
    this.setSelectedFile(firstFile === undefined ? undefined : getAbsolutePath(firstFile[0]));
  }

  setDocumentContent(filePath: AbsolutePath, newContent: string): void {
    const document = this.#editorStore.documents.get()[filePath];
    if (!document || document.isBinary) {
      return;
    }
    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges =
      originalContent !== undefined &&
      (originalContent !== newContent || (this.#pendingSaveCounts.get(filePath) ?? 0) > 0);
    if (document.value !== newContent) {
      this.#editVersions.set(filePath, (this.#editVersions.get(filePath) ?? 0) + 1);
    }
    this.#editorStore.updateFile(filePath, newContent);
    const next = new Set(this.unsavedFiles.get());
    if (unsavedChanges) {
      next.add(filePath);
    } else {
      next.delete(filePath);
    }
    this.unsavedFiles.set(next);
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition): void {
    const document = this.currentDocument.get();
    if (document) {
      this.#editorStore.updateScrollPosition(document.filePath, position);
    }
  }

  setSelectedFile(filePath: AbsolutePath | undefined): void {
    this.flushPendingEditorChange();
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string): Promise<void> {
    this.flushPendingEditorChange();
    const absolutePath = getAbsolutePath(filePath);

    while (true) {
      const document = this.#editorStore.documents.get()[absolutePath];
      if (!document) {
        if (this.unsavedFiles.get().has(absolutePath)) {
          throw new Error(`Cannot save ${absolutePath}: the editor document is unavailable.`);
        }
        return;
      }
      const content = document.value;
      const editVersion = this.#editVersions.get(absolutePath) ?? 0;
      const isCurrentEdit = () =>
        (this.#editVersions.get(absolutePath) ?? 0) === editVersion &&
        this.#editorStore.documents.get()[absolutePath]?.value === content;
      const workspaceGeneration = this.#workspaceGeneration;
      this.#pendingSaveCounts.set(absolutePath, (this.#pendingSaveCounts.get(absolutePath) ?? 0) + 1);
      let savedCurrentEdit: boolean;
      try {
        savedCurrentEdit = await this.#filesStore.saveFile(absolutePath, content, () => {
          this.flushPendingEditorChange();
          return isCurrentEdit();
        });
      } finally {
        if (this.#workspaceGeneration === workspaceGeneration) {
          const remainingSaves = (this.#pendingSaveCounts.get(absolutePath) ?? 1) - 1;
          if (remainingSaves === 0) {
            this.#pendingSaveCounts.delete(absolutePath);
          } else {
            this.#pendingSaveCounts.set(absolutePath, remainingSaves);
          }
        }
      }
      this.flushPendingEditorChange();
      if (!savedCurrentEdit || !isCurrentEdit()) {
        const next = new Set(this.unsavedFiles.get());
        next.add(absolutePath);
        this.unsavedFiles.set(next);
        continue;
      }
      const next = new Set(this.unsavedFiles.get());
      next.delete(absolutePath);
      this.unsavedFiles.set(next);
      return;
    }
  }

  async saveCurrentDocument(): Promise<void> {
    const current = this.currentDocument.get();
    if (current) {
      await this.saveFile(current.filePath);
    }
  }

  async saveUnsavedFiles(): Promise<void> {
    this.flushPendingEditorChange();
    while (this.unsavedFiles.get().size > 0) {
      for (const filePath of [...this.unsavedFiles.get()]) {
        await this.saveFile(filePath);
      }
      this.flushPendingEditorChange();
    }
  }

  resetCurrentDocument(): void {
    this.flushPendingEditorChange();
    const current = this.currentDocument.get();
    const file = current && this.#filesStore.getFile(current.filePath);
    if (current && file) {
      this.setDocumentContent(getAbsolutePath(current.filePath), file.content);
    }
  }

  getModifiedFiles(): Record<string, File> | undefined {
    this.flushPendingEditorChange();
    const modifiedFiles = {
      ...this.#filesStore.getModifiedFiles(),
      ...this.#visibleUnsavedTextFiles(),
    };
    return Object.keys(modifiedFiles).length > 0 ? modifiedFiles : undefined;
  }

  resetAllFileModifications(): void {
    this.#filesStore.resetFileModifications();
  }

  async downloadZip(): Promise<void> {
    this.flushPendingEditorChange();
    await downloadProject({ ...this.files.get(), ...this.#visibleUnsavedTextFiles() }, description.value ?? 'project');
  }

  #visibleUnsavedTextFiles() {
    const visibleFiles: UnsavedTextFiles = {};
    for (const filePath of this.unsavedFiles.get()) {
      const document = this.#editorStore.documents.get()[filePath];
      if (document && !document.isBinary) {
        visibleFiles[filePath] = { type: 'file', content: document.value, isBinary: false };
      }
    }
    return visibleFiles;
  }
}

export const workbenchStore = new WorkbenchStore();
