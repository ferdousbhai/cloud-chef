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

export function buildFileList(files: FileMap, rootFolder = '/', hideRoot: boolean): FileTreeNode[] {
  const folderPaths = new Set<string>();
  const nodes: FileTreeNode[] = [];
  let defaultDepth = 0;

  if (rootFolder === '/' && !hideRoot) {
    defaultDepth = 1;
    nodes.push({ kind: 'folder', name: '/', depth: 0, fullPath: '/' });
  }

  for (const [filePath, dirent] of Object.entries(files)) {
    const segments = filePath.split('/').filter(Boolean);
    const fileName = segments.at(-1);
    if (!fileName || isHiddenFile(filePath, fileName)) {
      continue;
    }

    let currentPath = '';
    let index = 0;
    let depth = 0;
    while (index < segments.length) {
      const name = segments[index];
      const fullPath = (currentPath += `/${name}`);
      if (!fullPath.startsWith(rootFolder) || (hideRoot && fullPath === rootFolder)) {
        index++;
        continue;
      }
      if (index === segments.length - 1 && dirent?.type === 'file') {
        nodes.push({ kind: 'file', name, fullPath, depth: depth + defaultDepth });
      } else if (!folderPaths.has(fullPath)) {
        folderPaths.add(fullPath);
        nodes.push({ kind: 'folder', name, fullPath, depth: depth + defaultDepth });
      }
      index++;
      depth++;
    }
  }

  return sortFileList(rootFolder, nodes, hideRoot);
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

function isHiddenFile(filePath: string, fileName: string): boolean {
  return DEFAULT_HIDDEN_FILES.some((pathOrRegex) =>
    pathOrRegex instanceof RegExp ? pathOrRegex.test(filePath) : fileName === pathOrRegex,
  );
}

function sortFileList(rootFolder: string, nodes: FileTreeNode[], hideRoot: boolean): FileTreeNode[] {
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

  if (!hideRoot) {
    visit(rootFolder);
  }
  for (const child of hideRoot ? (childrenMap.get(rootFolder) ?? []) : []) {
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
