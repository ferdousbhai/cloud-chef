import { useStore } from '@nanostores/react';
import { workbenchStore } from './workbench.client';

/** 'saving' while a save is being written, 'unsaved' while edits wait for one, otherwise null. */
export type FileSaveStatus = 'saving' | 'unsaved' | null;

export function useFileSaveStatus(): FileSaveStatus {
  const hasUnsavedFiles = useStore(workbenchStore.unsavedFiles).size > 0;
  const savesInFlight = useStore(workbenchStore.savesInFlight);
  // An archived conversation's editor is read only and cannot save, so its edits hold nothing back.
  const archived = useStore(workbenchStore.linkedProject)?.archived === true;
  return savesInFlight ? 'saving' : hasUnsavedFiles && !archived ? 'unsaved' : null;
}
