import { useStore } from '@nanostores/react';
import { workbenchStore } from './workbench.client';

/** 'saving' while a save is being written, 'unsaved' while edits wait for one, otherwise null. */
export type FileSaveStatus = 'saving' | 'unsaved' | null;

export function useFileSaveStatus(): FileSaveStatus {
  const hasUnsavedFiles = useStore(workbenchStore.unsavedFiles).size > 0;
  const savesInFlight = useStore(workbenchStore.savesInFlight);
  return savesInFlight ? 'saving' : hasUnsavedFiles ? 'unsaved' : null;
}
