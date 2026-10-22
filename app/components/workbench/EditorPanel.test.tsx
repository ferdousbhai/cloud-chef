import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuilderWorkspaceApplyResult } from '@cloudchef/user-workspace-runtime/protocol';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { EditorPanel } from './EditorPanel';

const fileA = getAbsolutePath('/home/project/a.ts');

afterEach(() => workbenchStore.activateWorkspace(crypto.randomUUID()));

function resetButton() {
  const markup = renderToStaticMarkup(
    <EditorPanel
      projectId="project-a"
      files={workbenchStore.files.get()}
      unsavedFiles={workbenchStore.unsavedFiles.get()}
      editorDocument={workbenchStore.currentDocument.get()}
      selectedFile={fileA}
    />,
  );
  const button = /<button(?:(?!<button).)*Reset<\/button>/.exec(markup)?.[0];
  if (!button) {
    throw new Error('Reset is not shown.');
  }
  return button;
}

describe('EditorPanel', () => {
  it('holds Reset back while a save is being written, since the save would land what it discards', async () => {
    workbenchStore.activateWorkspace('workspace-a');
    workbenchStore.files.set({ [fileA]: { type: 'file', content: 'a0', isBinary: false } });
    workbenchStore.setDocuments(workbenchStore.files.get());
    workbenchStore.setSelectedFile(fileA);
    workbenchStore.setDocumentContent(fileA, 'local edit');
    let finishSave: (result: BuilderWorkspaceApplyResult) => void = () => undefined;
    workbenchStore.setWorkspaceChangeListener(
      () =>
        new Promise<BuilderWorkspaceApplyResult>((resolve) => {
          finishSave = resolve;
        }),
    );
    expect(resetButton()).not.toContain('disabled=""');

    const save = workbenchStore.saveFile(fileA);
    expect(resetButton()).toContain('disabled=""');

    finishSave({
      ok: true,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 1, totalBytes: 10, seeding: false },
    });
    await save;
    workbenchStore.setDocumentContent(fileA, 'another edit');
    expect(resetButton()).not.toContain('disabled=""');
  });
});
