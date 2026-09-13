import type { AbsolutePath } from './utils/workDir.js';
import type { Tool } from './tool.js';
import type { AlwaysAvailableModelToolName, CloudflareMcpModelToolName } from './model-tool-inputs.js';

export interface EditorDocument {
  value: string;
  isBinary: boolean;
  filePath: AbsolutePath;
  scroll?: ScrollPosition;
}

export interface ScrollPosition {
  top: number;
  left: number;
}

export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
}

interface Folder {
  type: 'folder';
}

export type GhostbuildToolSet = Record<AlwaysAvailableModelToolName, Tool> &
  Partial<Record<CloudflareMcpModelToolName, Tool>>;

export type Dirent = File | Folder;

export type FileMap = Record<AbsolutePath, Dirent | undefined>;
