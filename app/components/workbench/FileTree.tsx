import { memo, useEffect, useMemo, useState } from 'react';
import type { FileMap } from 'cloudchef-agent/types';
import { DEFAULT_COLLAPSED_FOLDERS } from '~/utils/constants';
import { classNames } from '~/utils/classNames';
import { FileTreeNode } from './FileTreeNodes';
import { buildFileList, folderPathsFromFileList, visibleFileList } from './file-tree-model';

interface Props {
  files?: FileMap;
  selectedFile?: string;
  onFileSelect?: (filePath: string) => void;
  rootFolder?: string;
  /**
   * The tree inside the breadcrumb's dropdown: its rows are menu items, its folders start collapsed,
   * and the selected folder is highlighted.
   */
  inMenu?: boolean;
  unsavedFiles?: Set<string>;
  className?: string;
}

export const FileTree = memo(function FileTree({
  files = {},
  onFileSelect,
  selectedFile,
  rootFolder,
  inMenu = false,
  className,
  unsavedFiles,
}: Props) {
  const fileList = useMemo(() => buildFileList(files, rootFolder), [files, rootFolder]);
  const [collapsedFolders, setCollapsedFolders] = useState(() => initialCollapsedFolders(fileList, inMenu));

  useEffect(() => {
    if (inMenu) {
      setCollapsedFolders(new Set(folderPathsFromFileList(fileList)));
      return;
    }
    setCollapsedFolders(
      (previous) => new Set(folderPathsFromFileList(fileList).filter((folder) => previous.has(folder))),
    );
  }, [fileList, inMenu]);

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
          inMenu={inMenu}
          rootFolder={rootFolder}
          selectedFile={selectedFile}
          unsavedFiles={unsavedFiles}
          onFileSelect={onFileSelect}
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
