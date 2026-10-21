import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import { useFileSaveStatus } from './fileUpdateCounter';
import { workbenchStore } from './workbench.client';

function SaveStatus() {
  return <>{useFileSaveStatus() ?? 'clean'}</>;
}

afterEach(() => {
  workbenchStore.unsavedFiles.set(new Set());
  workbenchStore.linkedProject.set(null);
});

describe('useFileSaveStatus', () => {
  it('stops holding navigation for unsaved edits once their conversation is archived', () => {
    workbenchStore.unsavedFiles.set(new Set([getAbsolutePath('/home/project/a.ts')]));
    workbenchStore.linkedProject.set({ repository: 'acme/site', defaultBranch: 'main', archived: false });
    expect(renderToStaticMarkup(<SaveStatus />)).toBe('unsaved');

    workbenchStore.linkedProject.set({ repository: 'acme/site', defaultBranch: 'main', archived: true });

    expect(renderToStaticMarkup(<SaveStatus />)).toBe('clean');
  });
});
