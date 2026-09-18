import { memo, useEffect, useMemo, useState } from 'react';
import type { FileMap } from 'cloudchef-agent/types';
import { renderLogger } from 'cloudchef-agent/utils/logger';
import { DEFAULT_COLLAPSED_FOLDERS } from '~/utils/constants';
import { classNames } from '~/utils/classNames';
import { FileTreeNode } from './FileTreeNodes';
import { buildFileList, folderPathsFromFileList, visibleFileList } from './file-tree-model';

interface Props {
  files?: FileMap;
  selectedFile?: string;
  onFileSelect?: (filePath: string) => void;
  rootFolder?: string;
  hideRoot?: boolean;
  collapsed?: boolean;
  allowFolderSelection?: boolean;
  unsavedFiles?: Set<string>;
  className?: string;
  menuItems?: boolean;
}

export const FileTree = memo(function FileTree({
  files = {},
  onFileSelect,
  selectedFile,
  rootFolder,
  hideRoot = false,
  collapsed = false,
  allowFolderSelection = false,
  className,
  unsavedFiles,
  menuItems = false,
}: Props) {
  renderLogger.trace('FileTree');
  const fileList = useMemo(() => buildFileList(files, rootFolder, hideRoot), [files, rootFolder, hideRoot]);
  const [collapsedFolders, setCollapsedFolders] = useState(() => initialCollapsedFolders(fileList, collapsed));

  useEffect(() => {
    if (collapsed) {
      setCollapsedFolders(new Set(folderPathsFromFileList(fileList)));
      return;
    }
    setCollapsedFolders(
      (previous) => new Set(folderPathsFromFileList(fileList).filter((folder) => previous.has(folder))),
    );
  }, [fileList, collapsed]);

  const visibleNodes = useMemo(() => visibleFileList(fileList, collapsedFolders), [fileList, collapsedFolders]);
  const toggleCollapseState = (fullPath: string) => {
    setCollapsedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  };

  return (
    <div className={classNames('overflow-y-auto text-sm', className)}>
      {visibleNodes.map((node) => (
        <FileTreeNode
          key={node.fullPath}
          node={node}
          menuItems={menuItems}
          rootFolder={rootFolder}
          selectedFile={selectedFile}
          unsavedFiles={unsavedFiles}
          onFileSelect={onFileSelect}
          allowFolderSelection={allowFolderSelection}
          collapsedFolders={collapsedFolders}
          toggleCollapseState={toggleCollapseState}
        />
      ))}
    </div>
  );
});

FileTree.displayName = 'FileTree';

function initialCollapsedFolders(fileList: ReturnType<typeof buildFileList>, collapseAll: boolean): Set<string> {
  const folders = folderPathsFromFileList(fileList);
  return new Set(collapseAll ? folders : folders.filter((folder) => DEFAULT_COLLAPSED_FOLDERS.has(folder)));
}
