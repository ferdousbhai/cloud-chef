import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchStore } from './workbench.client';
import { getAbsolutePath, type AbsolutePath } from 'cloudchef-agent/utils/workDir';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceSyncEntry,
} from '@cloudchef/user-workspace-runtime/protocol';

const downloadProject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('~/lib/download/download-project', () => ({ downloadProject }));

const fileA = '/home/project/a.ts' as AbsolutePath;
const fileB = '/home/project/b.ts' as AbsolutePath;

function createStore() {
  const store = new WorkbenchStore();
  store.activateWorkspace('workspace-a');
  store.files.set({
    [fileA]: { type: 'file', content: 'a0', isBinary: false },
    [fileB]: { type: 'file', content: 'b0', isBinary: false },
  });
  store.setDocuments(store.files.get());
  store.setSelectedFile(fileA);
  return store;
}

function syncWrite(path: AbsolutePath, content: string, revision = 1): BuilderWorkspaceSyncEntry {
  return {
    kind: 'write',
    path,
    content,
    encoding: 'utf8',
    size: new TextEncoder().encode(content).byteLength,
    sha256: 'a'.repeat(64),
    revision,
  };
}

describe('WorkbenchStore editor flush boundaries', () => {
  beforeEach(() => downloadProject.mockClear());

  it('flushes the original file before changing selection', () => {
    const store = createStore();
    const flush = vi.fn(() => store.setDocumentContent(fileA, 'a1'));
    store.registerPendingEditorChangeFlusher(flush);

    store.setSelectedFile(fileB);

    expect(flush).toHaveBeenCalledOnce();
    expect(store.unsavedFiles.get()).toContain(fileA);
    expect(store.currentDocument.get()?.filePath).toBe(fileB);
  });

  it('flushes visible content before a manual durable save', async () => {
    const store = createStore();
    const apply = vi.fn(async () => ({
      ok: true as const,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    }));
    store.setWorkspaceChangeListener(apply);
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, 'latest visible content'));

    await store.saveCurrentDocument();

    expect(apply).toHaveBeenCalledWith(
      [{ kind: 'write', path: fileA, content: 'latest visible content', encoding: 'utf8' }],
      expect.any(Function),
    );
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('saves every browser-only edit before a builder turn', async () => {
    const store = createStore();
    const apply = vi.fn(async () => ({
      ok: true as const,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    }));
    store.setWorkspaceChangeListener(apply);
    store.setDocumentContent(fileA, 'a1');
    store.setDocumentContent(fileB, 'b1');

    await store.saveUnsavedFiles();

    expect(apply).toHaveBeenNthCalledWith(
      1,
      [{ kind: 'write', path: fileA, content: 'a1', encoding: 'utf8' }],
      expect.any(Function),
    );
    expect(apply).toHaveBeenNthCalledWith(
      2,
      [{ kind: 'write', path: fileB, content: 'b1', encoding: 'utf8' }],
      expect.any(Function),
    );
    expect(store.unsavedFiles.get()).toEqual(new Set());
  });

  it('waits for a newer same-file edit to become durable before completing a turn-boundary save', async () => {
    const store = createStore();
    const finishSaves: Array<(result: BuilderWorkspaceApplyResult) => void> = [];
    const apply = vi.fn((changes: BuilderWorkspaceClientChange[], isCurrentChange: () => boolean) => {
      return new Promise<BuilderWorkspaceApplyResult>((resolve) => {
        finishSaves.push((result) => {
          const change = changes[0];
          if (change?.kind === 'write' && isCurrentChange()) {
            store.applyWorkspaceSyncEntries([syncWrite(fileA, change.content, result.state.revision)]);
          }
          resolve(result);
        });
      });
    });
    store.setWorkspaceChangeListener(apply);
    let visibleContent = 'older edit';
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, visibleContent));
    let saveCompleted = false;
    const save = store.saveUnsavedFiles().then(() => {
      saveCompleted = true;
    });

    visibleContent = 'a0';
    finishSaves[0]({
      ok: true,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(apply).toHaveBeenNthCalledWith(
      1,
      [{ kind: 'write', path: fileA, content: 'older edit', encoding: 'utf8' }],
      expect.any(Function),
    );
    expect(apply).toHaveBeenNthCalledWith(
      2,
      [{ kind: 'write', path: fileA, content: 'a0', encoding: 'utf8' }],
      expect.any(Function),
    );
    expect(saveCompleted).toBe(false);
    expect(store.files.get()[fileA]).toMatchObject({ content: 'a0' });
    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'a0' });
    expect(store.unsavedFiles.get()).toContain(fileA);

    finishSaves[1]({
      ok: true,
      changedPaths: [fileA],
      state: { initialized: true, revision: 3, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    });
    await save;

    expect(store.files.get()[fileA]).toMatchObject({ content: 'a0' });
    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'a0' });
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('reports a save in flight only while one is being written', async () => {
    const store = createStore();
    let finishSave!: (result: BuilderWorkspaceApplyResult) => void;
    store.setWorkspaceChangeListener(
      () =>
        new Promise<BuilderWorkspaceApplyResult>((resolve) => {
          finishSave = resolve;
        }),
    );
    store.setDocumentContent(fileA, 'local edit');

    expect(store.unsavedFiles.get()).toContain(fileA);
    expect(store.savesInFlight.get()).toBe(false);
    const save = store.saveCurrentDocument();
    expect(store.savesInFlight.get()).toBe(true);
    finishSave({
      ok: true,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    });
    await save;

    expect(store.unsavedFiles.get()).not.toContain(fileA);
    expect(store.savesInFlight.get()).toBe(false);
  });

  it('does not apply a save completion to a newly activated workspace', async () => {
    const store = createStore();
    let finishSave!: (result: {
      ok: true;
      changedPaths: AbsolutePath[];
      state: {
        initialized: true;
        revision: number;
        resetRevision: number;
        fileCount: number;
        totalBytes: number;
        seeding: false;
      };
    }) => void;
    store.setWorkspaceChangeListener(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    store.setDocumentContent(fileA, 'workspace-a edit');
    const save = store.saveCurrentDocument();

    store.activateWorkspace('workspace-b');
    store.files.set({ [fileB]: { type: 'file', content: 'workspace-b content', isBinary: false } });
    store.setDocuments(store.files.get());
    finishSave({
      ok: true,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    });

    await expect(save).rejects.toThrow('active workspace changed');
    expect(store.files.get()[fileA]).toBeUndefined();
    expect(store.files.get()[fileB]).toMatchObject({ content: 'workspace-b content' });
  });

  it('fails instead of retrying forever when an unsaved document becomes unavailable', async () => {
    const store = createStore();
    store.unsavedFiles.set(new Set([getAbsolutePath('/home/project/missing.ts')]));

    await expect(store.saveUnsavedFiles()).rejects.toThrow('the editor document is unavailable');
  });

  it('keeps an unsaved file as a local recreation when a delta deletes it', async () => {
    const store = createStore();
    const apply = vi.fn(async () => ({
      ok: true as const,
      changedPaths: [fileA],
      state: { initialized: true, revision: 3, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    }));
    store.setWorkspaceChangeListener(apply);
    store.setDocumentContent(fileA, 'local edit');

    store.applyWorkspaceSyncEntries([{ kind: 'delete', path: fileA, revision: 2 }]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'local edit' });
    expect(store.files.get()[fileA]).toMatchObject({ content: 'local edit' });
    expect(store.unsavedFiles.get()).toContain(fileA);
    await store.saveUnsavedFiles();
    expect(apply).toHaveBeenCalledWith(
      [{ kind: 'write', path: fileA, content: 'local edit', encoding: 'utf8' }],
      expect.any(Function),
    );
  });

  it.each([
    {
      path: 'delta',
      deleteFileA: (store: WorkbenchStore) =>
        store.applyWorkspaceSyncEntries([{ kind: 'delete', path: fileA, revision: 2 }]),
    },
    {
      path: 'snapshot',
      deleteFileA: (store: WorkbenchStore) => store.replaceWorkspaceSnapshot([syncWrite(fileB, 'b1')]),
    },
  ])(
    'keeps a $path-deleted local recreation unsaved until saved, and Reset accepts the deletion',
    ({ deleteFileA }) => {
      const store = createStore();
      store.setDocumentContent(fileA, 'local edit');
      deleteFileA(store);

      // Typing back to the staged text does not make it clean: nothing durable holds it.
      store.setDocumentContent(fileA, 'local edit 2');
      store.setDocumentContent(fileA, 'local edit');
      expect(store.unsavedFiles.get()).toContain(fileA);

      store.resetCurrentDocument();

      expect(store.files.get()[fileA]).toBeUndefined();
      expect(store.unsavedFiles.get()).not.toContain(fileA);
      expect(store.currentDocument.get()?.filePath).toBe(fileB);
    },
  );

  it('lets a local recreation reset while its save is in flight stay reset when the save lands', async () => {
    const store = createStore();
    let finishSave: (result: BuilderWorkspaceApplyResult) => void = () => undefined;
    store.setWorkspaceChangeListener(
      () =>
        new Promise<BuilderWorkspaceApplyResult>((resolve) => {
          finishSave = resolve;
        }),
    );
    store.setDocumentContent(fileA, 'local edit');
    store.applyWorkspaceSyncEntries([{ kind: 'delete', path: fileA, revision: 2 }]);
    const save = store.saveUnsavedFiles();

    store.resetCurrentDocument();
    finishSave({
      ok: true,
      changedPaths: [fileA],
      state: { initialized: true, revision: 3, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    });

    await expect(save).resolves.toBeUndefined();
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('treats a saved local recreation as durable again', async () => {
    const store = createStore();
    store.setWorkspaceChangeListener(async () => ({
      ok: true as const,
      changedPaths: [fileA],
      state: { initialized: true, revision: 3, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    }));
    store.setDocumentContent(fileA, 'local edit');
    store.applyWorkspaceSyncEntries([{ kind: 'delete', path: fileA, revision: 2 }]);

    await store.saveUnsavedFiles();
    store.setDocumentContent(fileA, 'local edit 2');
    store.setDocumentContent(fileA, 'local edit');

    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('drops an unsaved marker with no text document when a delta deletes its file', () => {
    const store = createStore();
    const binaryFile = getAbsolutePath('/home/project/logo.png');
    store.files.setKey(binaryFile, { type: 'file', content: '', isBinary: true });
    store.setDocuments(store.files.get());
    store.unsavedFiles.set(new Set([binaryFile]));

    store.applyWorkspaceSyncEntries([{ kind: 'delete', path: binaryFile, revision: 2 }]);

    expect(store.files.get()[binaryFile]).toBeUndefined();
    expect(store.unsavedFiles.get()).toEqual(new Set());
  });

  it('tracks visible unsaved content until it is durably saved', () => {
    const store = createStore();
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, 'latest visible content'));

    expect(store.getModifiedFiles()).toEqual({
      [fileA]: { type: 'file', content: 'latest visible content', isBinary: false },
    });
  });

  it('includes visible unsaved content in a downloaded project', async () => {
    const store = createStore();
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, 'latest visible content'));

    await store.downloadZip();

    expect(downloadProject).toHaveBeenCalledWith(
      expect.objectContaining({
        [fileA]: { type: 'file', content: 'latest visible content', isBinary: false },
        [fileB]: { type: 'file', content: 'b0', isBinary: false },
      }),
      expect.any(String),
    );
  });

  it('does not write text into a binary document', () => {
    const store = createStore();
    store.files.setKey(fileA, { type: 'file', content: '', isBinary: true });
    store.setDocuments(store.files.get());

    store.setDocumentContent(fileA, 'stale text');

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, isBinary: true, value: '' });
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('preserves visible unsaved text across a replacement snapshot', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'local edit');

    store.replaceWorkspaceSnapshot([syncWrite(fileA, 'new durable content'), syncWrite(fileB, 'b1')]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'local edit' });
    expect(store.files.get()[fileA]).toMatchObject({ content: 'new durable content' });
    expect(store.unsavedFiles.get()).toContain(fileA);
  });

  it('selectively reconciles a stale-save snapshot without advancing that file baseline', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'newer local edit');

    store.replaceWorkspaceSnapshot(
      [syncWrite(fileA, 'stale saved edit'), syncWrite(fileB, 'remote change')],
      new Set([fileA]),
    );

    expect(store.files.get()[fileA]).toMatchObject({ content: 'a0' });
    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'newer local edit' });
    expect(store.unsavedFiles.get()).toContain(fileA);
    expect(store.files.get()[fileB]).toMatchObject({ content: 'remote change' });
  });

  it('keeps an unsaved file as a local recreation when the replacement snapshot deleted it', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'local edit');

    store.replaceWorkspaceSnapshot([syncWrite(fileB, 'b1')]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'local edit' });
    expect(store.files.get()[fileA]).toMatchObject({ content: 'local edit' });
    expect(store.unsavedFiles.get()).toContain(fileA);
  });

  it('clears an unsaved marker when the replacement snapshot already contains the local text', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'same content');

    store.replaceWorkspaceSnapshot([syncWrite(fileA, 'same content'), syncWrite(fileB, 'b1')]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'same content' });
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('drops every project-scoped presentation value before activating another workspace', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'private workspace-a edit');
    store.showWorkbench.set(true);
    store.currentView.set('preview');

    store.activateWorkspace('workspace-b');
    store.replaceWorkspaceSnapshot([syncWrite(fileB, 'workspace-b content')]);

    expect(store.files.get()[fileA]).toBeUndefined();
    expect(store.files.get()[fileB]).toMatchObject({ content: 'workspace-b content' });
    expect(store.unsavedFiles.get()).toEqual(new Set());
    expect(store.selectedFile.get()).toBe(fileB);
    expect(store.currentView.get()).toBe('code');
    expect(store.showWorkbench.get()).toBe(false);
    expect(store.linkedSite.get()).toBeNull();
  });
});
