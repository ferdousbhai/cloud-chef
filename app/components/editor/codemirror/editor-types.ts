import type { ScrollPosition } from 'cloudchef-agent/types';

export interface EditorUpdate {
  content: string;
  filePath: string;
  projectId: string;
}

export type OnChangeCallback = (update: EditorUpdate) => void;
export type OnScrollCallback = (position: ScrollPosition) => void;
export type OnWheelCallback = () => void;
export type OnSaveCallback = () => void;
