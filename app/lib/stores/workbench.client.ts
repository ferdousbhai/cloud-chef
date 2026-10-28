import { atom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, File, FileMap, ScrollPosition } from 'cloudchef-agent/types';
import type { AbsolutePath } from 'cloudchef-agent/utils/workDir';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import type { BuilderWorkspaceSyncEntry } from '@cloudchef/user-workspace-runtime/protocol';
import type { BuilderLinkedProjectSummary, BuilderLinkedSite } from '~/agents/conversation-agent';
import type { WorkspacePresentationState } from '~/components/chat/useConversationAgentChat';
import { downloadProject } from '~/lib/download/download-project';
import { description } from './description';
import { EditorStore } from './editor';
import { FilesStore, type WorkspaceChangeListener } from './files';
import { AppSiteStore } from './app-site';

/** Editor buffers that differ from what is on disk and are renderable as text. */
type UnsavedTextFiles = Record<AbsolutePath, File>;

export type WorkbenchViewType = 'code' | 'preview' | 'terminal';

/** Where the active workspace's files stand, as the chat loading them reports it, with its retry. */
export type WorkspaceFilesStatus = {
  state: WorkspacePresentationState;
  /** Why, when the agent could not put the project's files in the workspace. */
  failure: string | null;
  retry: (() => void) | null;
};

const CONNECTING_WORKSPACE_FILES: WorkspaceFilesStatus = { state: 'connecting', failure: null, retry: null };

export class WorkbenchStore {
  #appSiteStore = new AppSiteStore();
  #filesStore = new FilesStore();
  #editorStore = new EditorStore();
  #flushPendingEditorChange: (() => void) | null = null;
  #workspaceId: string | null = null;
  #workspaceGeneration = 0;
  #editVersions = new Map<AbsolutePath, number>();
  #pendingSaveCounts = new Map<AbsolutePath, number>();
  /**
   * Files the workspace deleted while the user still had edits, kept in the browser as recreations. Their
   * files-store entry is the local text, not a durable baseline, so they stay unsaved until a save lands.
   */
  #stagedRecreations = new Set<AbsolutePath>();
  #savesInFlight = atom(false);
  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> = import.meta.hot?.data.workbenchCurrentView ?? atom('code');
  unsavedFiles: WritableAtom<Set<AbsolutePath>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<AbsolutePath>());
  /**
   * The GitHub project the active workspace works on, or null for a CloudChef app (and until the agent
   * says). A GitHub project previews and deploys through its repository's pipeline, not CloudChef's.
   */
  linkedProject: WritableAtom<BuilderLinkedProjectSummary | null> = atom(null);
  /** What a team or uploaded project's Preview shows: its newest preview from this conversation, else its live site. */
  linkedSite: WritableAtom<BuilderLinkedSite | null> = atom(null);
  /** A newer conversation in the chat continues the project: this one's files are shown to read only. */
  conversationClosed: WritableAtom<boolean> = atom(false);
  /** A team adopted this app as one of its projects: it is closed for that reason, and changed from the project. */
  conversationAdopted: WritableAtom<boolean> = atom(false);
  /** How the active workspace's files are reaching the browser, which the code view says while it has none. */
  workspaceFiles: WritableAtom<WorkspaceFilesStatus> = atom(CONNECTING_WORKSPACE_FILES);

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.workbenchCurrentView = this.currentView;
    }
  }

  get followingStreamedCode() {
    return this.#editorStore.followingStreamedCode;
  }

  get siteState() {
    return this.#appSiteStore.state;
  }

  connectSite(...args: Parameters<AppSiteStore['connect']>) {
    return this.#appSiteStore.connect(...args);
  }

  updateSite(...args: Parameters<AppSiteStore['update']>) {
    return this.#appSiteStore.update(...args);
  }

  get publicationState() {
    return this.#appSiteStore.publication;
  }

  updatePublication(...args: Parameters<AppSiteStore['updatePublication']>) {
    return this.#appSiteStore.updatePublication(...args);
  }

  publishSite(...args: Parameters<AppSiteStore['publish']>) {
    return this.#appSiteStore.publish(...args);
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
    this.#stagedRecreations.clear();
    this.#savesInFlight.set(false);
    this.#filesStore.setWorkspaceChangeListener(null);
    this.unsavedFiles.set(new Set());
    this.#filesStore.replaceWorkspaceSnapshot([]);
    this.#editorStore.setDocuments({});
    this.#editorStore.setSelectedFile(undefined);
    this.#editorStore.followingStreamedCode.set(true);
    this.#appSiteStore.reset();
    this.linkedProject.set(null);
    this.linkedSite.set(null);
    this.conversationClosed.set(false);
    this.conversationAdopted.set(false);
    this.workspaceFiles.set(CONNECTING_WORKSPACE_FILES);
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
    const unsavedDocuments = this.#unsavedTextDocuments();
    this.#filesStore.applyWorkspaceSyncEntries(entries);
    for (const entry of entries) {
      this.#stagedRecreations.delete(getAbsolutePath(entry.path));
    }

    const durableFiles = this.#filesStore.files.get();
    const nextUnsavedFiles = new Set<AbsolutePath>();
    for (const filePath of this.unsavedFiles.get()) {
      if (durableFiles[filePath]?.type === 'file') {
        nextUnsavedFiles.add(filePath);
        continue;
      }
      // A delta can delete a file the user is still editing. Keep the local text as an unsaved
      // recreation, as a full snapshot does, rather than leaving a marker with nothing to save.
      const document = unsavedDocuments.get(filePath);
      if (document) {
        this.#stageRecreation(filePath, document.value);
        nextUnsavedFiles.add(filePath);
      }
    }

    this.unsavedFiles.set(nextUnsavedFiles);
    this.setDocuments(this.#filesStore.files.get());
  }

  replaceWorkspaceSnapshot(entries: BuilderWorkspaceSyncEntry[], preservedPaths?: ReadonlySet<string>): void {
    this.flushPendingEditorChange();

    const unsavedDocuments = this.#unsavedTextDocuments();
    this.#filesStore.replaceWorkspaceSnapshot(entries, preservedPaths);
    for (const filePath of this.#stagedRecreations) {
      if (!preservedPaths?.has(filePath)) {
        this.#stagedRecreations.delete(filePath);
      }
    }

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
      this.#stageRecreation(filePath, document.value);
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

  /** Whether a save is being written to the workspace now, as opposed to edits merely waiting for one. */
  get savesInFlight(): ReadableAtom<boolean> {
    return this.#savesInFlight;
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
      (this.#stagedRecreations.has(filePath) ||
        originalContent !== newContent ||
        (this.#pendingSaveCounts.get(filePath) ?? 0) > 0);
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
      this.#savesInFlight.set(true);
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
          this.#savesInFlight.set(this.#pendingSaveCounts.size > 0);
        }
      }
      this.flushPendingEditorChange();
      if (!this.#editorStore.documents.get()[absolutePath]) {
        // Reset accepted the workspace's deletion of this draft while it was being written: nothing is left to save.
        return;
      }
      if (!savedCurrentEdit || !isCurrentEdit()) {
        const next = new Set(this.unsavedFiles.get());
        next.add(absolutePath);
        this.unsavedFiles.set(next);
        continue;
      }
      this.#stagedRecreations.delete(absolutePath);
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
    if (current && this.#stagedRecreations.has(current.filePath)) {
      // The workspace deleted this file; the browser held only the draft. Resetting accepts the deletion.
      this.#stagedRecreations.delete(current.filePath);
      this.#filesStore.discardUnsavedTextFile(current.filePath);
      const next = new Set(this.unsavedFiles.get());
      next.delete(current.filePath);
      this.unsavedFiles.set(next);
      this.setDocuments(this.#filesStore.files.get());
      return;
    }
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

  #stageRecreation(filePath: AbsolutePath, content: string): void {
    this.#filesStore.stageUnsavedTextFile(filePath, content);
    this.#stagedRecreations.add(filePath);
  }

  #unsavedTextDocuments(): Map<AbsolutePath, EditorDocument> {
    return new Map(
      [...this.unsavedFiles.get()]
        .map((filePath) => [filePath, this.#editorStore.documents.get()[filePath]] as const)
        .filter(
          (entry): entry is readonly [AbsolutePath, EditorDocument] => entry[1] !== undefined && !entry[1].isBinary,
        ),
    );
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
