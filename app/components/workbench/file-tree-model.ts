import type { FileMap } from 'cloudchef-agent/types';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';

const logger = createScopedLogger('FileTreeModel');

const DEFAULT_HIDDEN_FILES = [/\/node_modules\//, /\/\.next/, /\/\.astro/];

type BaseNode = {
  depth: number;
  name: string;
  fullPath: string;
};

export type FileNode = BaseNode & { kind: 'file' };
export type FolderNode = BaseNode & { kind: 'folder' };
type FileTreeNode = FileNode | FolderNode;

/** The files under `rootFolder`, depth-first in display order; the root folder itself is not listed. */
export function buildFileList(files: FileMap, rootFolder = '/'): FileTreeNode[] {
  const folderPaths = new Set<string>();
  const nodes: FileTreeNode[] = [];

  for (const [filePath, dirent] of Object.entries(files)) {
    const segments = filePath.split('/').filter(Boolean);
    const fileName = segments.at(-1);
    if (!fileName || DEFAULT_HIDDEN_FILES.some((pattern) => pattern.test(filePath))) {
      continue;
    }

    let currentPath = '';
    let index = 0;
    let depth = 0;
    while (index < segments.length) {
      const name = segments[index];
      const fullPath = (currentPath += `/${name}`);
      if (!fullPath.startsWith(rootFolder) || fullPath === rootFolder) {
        index++;
        continue;
      }
      if (index === segments.length - 1 && dirent?.type === 'file') {
        nodes.push({ kind: 'file', name, fullPath, depth });
      } else if (!folderPaths.has(fullPath)) {
        folderPaths.add(fullPath);
        nodes.push({ kind: 'folder', name, fullPath, depth });
      }
      index++;
      depth++;
    }
  }

  return sortFileList(rootFolder, nodes);
}

export function folderPathsFromFileList(nodes: FileTreeNode[]): string[] {
  return nodes.filter((node) => node.kind === 'folder').map((node) => node.fullPath);
}

export function visibleFileList(nodes: FileTreeNode[], collapsedFolders: Set<string>): FileTreeNode[] {
  const visible: FileTreeNode[] = [];
  let collapsedDepth = Number.MAX_SAFE_INTEGER;

  for (const node of nodes) {
    if (collapsedDepth === node.depth) {
      collapsedDepth = Number.MAX_SAFE_INTEGER;
    }
    if (collapsedFolders.has(node.fullPath)) {
      collapsedDepth = Math.min(collapsedDepth, node.depth);
    }
    if (collapsedDepth >= node.depth) {
      visible.push(node);
    }
  }
  return visible;
}

function sortFileList(rootFolder: string, nodes: FileTreeNode[]): FileTreeNode[] {
  logger.trace('sortFileList');
  const nodeMap = new Map<string, FileTreeNode>();
  const childrenMap = new Map<string, FileTreeNode[]>();
  nodes.sort(compareNodes);

  for (const node of nodes) {
    nodeMap.set(node.fullPath, node);
    const parentPath = node.fullPath.slice(0, node.fullPath.lastIndexOf('/'));
    if (parentPath !== rootFolder.slice(0, rootFolder.lastIndexOf('/'))) {
      const children = childrenMap.get(parentPath) ?? [];
      children.push(node);
      childrenMap.set(parentPath, children);
    }
  }

  const sorted: FileTreeNode[] = [];
  const visit = (path: string): void => {
    const node = nodeMap.get(path);
    if (node) {
      sorted.push(node);
    }
    for (const child of childrenMap.get(path) ?? []) {
      if (child.kind === 'folder') {
        visit(child.fullPath);
      } else {
        sorted.push(child);
      }
    }
  };

  for (const child of childrenMap.get(rootFolder) ?? []) {
    visit(child.fullPath);
  }
  return sorted;
}

function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.kind !== b.kind) {
    return a.kind === 'folder' ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}
