import type { EditorSelection } from '@codemirror/state';
import type { ScrollPosition } from 'ghostbuild-agent/types';

export interface EditorUpdate {
  selection: EditorSelection;
  content: string;
  filePath: string;
  projectId: string;
}

export type OnChangeCallback = (update: EditorUpdate) => void;
export type OnScrollCallback = (position: ScrollPosition) => void;
export type OnWheelCallback = () => void;
export type OnSaveCallback = () => void;
