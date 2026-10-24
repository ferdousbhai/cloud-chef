import { useStore } from '@nanostores/react';
import { workbenchStore } from './workbench.client';

/** 'saving' while a save is being written, 'unsaved' while edits wait for one, otherwise null. */
export type FileSaveStatus = 'saving' | 'unsaved' | null;

export function useFileSaveStatus(): FileSaveStatus {
  const hasUnsavedFiles = useStore(workbenchStore.unsavedFiles).size > 0;
  const savesInFlight = useStore(workbenchStore.savesInFlight);
  // A closed conversation's editor is read only and cannot save, so its edits hold nothing back.
  const closed = useStore(workbenchStore.conversationClosed);
  return savesInFlight ? 'saving' : hasUnsavedFiles && !closed ? 'unsaved' : null;
}
