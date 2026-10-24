import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import { useFileSaveStatus } from './file-save-status';
import { workbenchStore } from './workbench.client';

function SaveStatus() {
  return <>{useFileSaveStatus() ?? 'clean'}</>;
}

afterEach(() => {
  workbenchStore.unsavedFiles.set(new Set());
  workbenchStore.conversationClosed.set(false);
});

describe('useFileSaveStatus', () => {
  it('stops holding navigation for unsaved edits once a newer conversation continues the project', () => {
    workbenchStore.unsavedFiles.set(new Set([getAbsolutePath('/home/project/a.ts')]));
    expect(renderToStaticMarkup(<SaveStatus />)).toBe('unsaved');

    workbenchStore.conversationClosed.set(true);

    expect(renderToStaticMarkup(<SaveStatus />)).toBe('clean');
  });
});
