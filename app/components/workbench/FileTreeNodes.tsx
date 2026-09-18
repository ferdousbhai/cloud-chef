import * as ContextMenu from '@radix-ui/react-context-menu';
import { CaretDownIcon, CaretRightIcon, FileIcon } from '@radix-ui/react-icons';
import { useCallback, type ReactNode } from 'react';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { classNames } from '~/utils/classNames';
import type { FileNode, FolderNode } from './file-tree-model';

const logger = createScopedLogger('FileTreeNodes');
const NODE_PADDING_LEFT = 8;

interface FileTreeNodeProps {
  node: FileNode | FolderNode;
  rootFolder?: string;
  selectedFile?: string;
  unsavedFiles?: Set<string>;
  onFileSelect?: (filePath: string) => void;
  allowFolderSelection?: boolean;
  collapsedFolders: Set<string>;
  toggleCollapseState: (fullPath: string) => void;
}

export function FileTreeNode({
  node,
  rootFolder,
  selectedFile,
  unsavedFiles,
  onFileSelect,
  allowFolderSelection,
  collapsedFolders,
  toggleCollapseState,
}: FileTreeNodeProps) {
  const copyPath = useCallback(() => copyToClipboard(node.fullPath), [node.fullPath]);
  const copyRelativePath = useCallback(
    () => copyToClipboard(node.fullPath.substring((rootFolder || '').length)),
    [node.fullPath, rootFolder],
  );
  if (node.kind === 'file') {
    return (
      <File
        selected={selectedFile === node.fullPath}
        file={node}
        unsavedChanges={unsavedFiles?.has(node.fullPath)}
        onCopyPath={copyPath}
        onCopyRelativePath={copyRelativePath}
        onClick={() => onFileSelect?.(node.fullPath)}
      />
    );
  }
  return (
    <Folder
      folder={node}
      selected={allowFolderSelection && selectedFile === node.fullPath}
      collapsed={collapsedFolders.has(node.fullPath)}
      onCopyPath={copyPath}
      onCopyRelativePath={copyRelativePath}
      onClick={() => toggleCollapseState(node.fullPath)}
    />
  );
}

function copyToClipboard(value: string): void {
  try {
    void navigator.clipboard.writeText(value).catch((error) => logger.error('Failed to copy file path', error));
  } catch (error) {
    logger.error('Failed to copy file path', error);
  }
}

interface NodeActions {
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onClick: () => void;
}

function Folder({
  folder,
  collapsed,
  selected = false,
  ...actions
}: NodeActions & { folder: FolderNode; collapsed: boolean; selected?: boolean }) {
  return (
    <FileContextMenu {...actions}>
      <NodeButton
        className={classNames('group', {
          'bg-transparent text-bolt-elements-item-contentDefault hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-item-contentActive':
            !selected,
          'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent': selected,
        })}
        depth={folder.depth}
        expanded={!collapsed}
        icon={collapsed ? <CaretRightIcon /> : <CaretDownIcon />}
        onClick={actions.onClick}
      >
        {folder.name}
      </NodeButton>
    </FileContextMenu>
  );
}

function File({
  file,
  selected,
  unsavedChanges = false,
  ...actions
}: NodeActions & { file: FileNode; selected: boolean; unsavedChanges?: boolean }) {
  return (
    <FileContextMenu {...actions}>
      <NodeButton
        className={classNames('group', {
          'bg-transparent text-bolt-elements-item-contentDefault hover:bg-bolt-elements-item-backgroundActive':
            !selected,
          'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent': selected,
        })}
        current={selected}
        depth={file.depth}
        icon={<FileIcon className={classNames({ 'group-hover:text-bolt-elements-item-contentActive': !selected })} />}
        onClick={actions.onClick}
      >
        <div
          className={classNames('flex items-center', {
            'group-hover:text-bolt-elements-item-contentActive': !selected,
          })}
        >
          <div className="flex-1 truncate pr-2">{file.name}</div>
          {unsavedChanges && (
            <span className="size-1.5 shrink-0 rounded-full bg-orange-500">
              <span className="sr-only"> (unsaved)</span>
            </span>
          )}
        </div>
      </NodeButton>
    </FileContextMenu>
  );
}

function FileContextMenu({
  onCopyPath,
  onCopyRelativePath,
  children,
}: Pick<NodeActions, 'onCopyPath' | 'onCopyRelativePath'> & { children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          style={{ zIndex: 998 }}
          className="z-context-menu w-56 rounded-md border bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-2"
        >
          <ContextMenu.Group className="border-b p-1">
            <ContextMenuItem onSelect={onCopyPath}>Copy path</ContextMenuItem>
            <ContextMenuItem onSelect={onCopyRelativePath}>Copy relative path</ContextMenuItem>
          </ContextMenu.Group>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function ContextMenuItem({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-bolt-elements-item-contentDefault outline-0 hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-item-contentActive"
    >
      <span className="size-4 shrink-0" />
      <span>{children}</span>
    </ContextMenu.Item>
  );
}

function NodeButton({
  depth,
  icon,
  expanded,
  current,
  onClick,
  className,
  children,
}: {
  depth: number;
  icon: ReactNode;
  expanded?: boolean;
  current?: boolean;
  children: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-current={current ? true : undefined}
      className={classNames(
        'flex w-full items-center gap-1.5 border-2 border-transparent py-0.5 pr-2 text-faded',
        className,
      )}
      style={{ paddingLeft: `${6 + depth * NODE_PADDING_LEFT}px` }}
      onClick={onClick}
    >
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1 truncate text-left">{children}</div>
    </button>
  );
}
