import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { memo, useState } from 'react';
import type { FileMap } from 'ghostbuild-agent/types';
import { classNames } from '~/utils/classNames';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { cubicEasingFn } from '~/utils/easings';
import { renderLogger } from 'ghostbuild-agent/utils/logger';
import { FileTree } from './FileTree';
import { FileIcon, ChevronRightIcon } from '@radix-ui/react-icons';

const WORK_DIR_PARENT_PREFIX = `${WORK_DIR.split('/').slice(0, -1).join('/')}/`;

function isWorkspaceParentPath(path: string) {
  return path.startsWith(WORK_DIR_PARENT_PREFIX);
}

interface FileBreadcrumbProps {
  files?: FileMap;
  pathSegments?: string[];
  onFileSelect?: (filePath: string) => void;
}

const contextMenuVariants = {
  open: {
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.15,
      ease: cubicEasingFn,
    },
  },
  close: {
    y: 6,
    opacity: 0,
    transition: {
      duration: 0.15,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

export const FileBreadcrumb = memo<FileBreadcrumbProps>(function FileBreadcrumb({
  files,
  pathSegments = [],
  onFileSelect,
}: FileBreadcrumbProps) {
  renderLogger.trace('FileBreadcrumb');

  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (files === undefined || pathSegments.length === 0) {
    return null;
  }

  return (
    <div className="flex">
      {pathSegments.map((segment, index) => {
        const isLast = index === pathSegments.length - 1;

        const path = pathSegments.slice(0, index).join('/');

        if (!isWorkspaceParentPath(path)) {
          return null;
        }

        const isActive = activeIndex === index;

        return (
          <div key={index} className="relative flex items-center">
            <DropdownMenu.Root
              open={isActive}
              onOpenChange={(open) => {
                setActiveIndex((current) => (open ? index : current === index ? null : current));
              }}
              modal={false}
            >
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className={classNames('flex shrink-0 cursor-pointer items-center gap-1.5 rounded bg-transparent', {
                    'text-content-tertiary hover:text-content-primary': !isActive,
                    'text-content-primary underline': isActive,
                    'pr-4': isLast,
                  })}
                  aria-label={`Browse ${segment}`}
                >
                  {isLast && <FileIcon />}
                  {segment}
                </button>
              </DropdownMenu.Trigger>
              {index > 0 && !isLast && <ChevronRightIcon className="mx-1 inline-block" />}
              <AnimatePresence>
                {isActive && (
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="z-file-tree-breadcrumb"
                      asChild
                      align="start"
                      side="bottom"
                      avoidCollisions={false}
                    >
                      <motion.div initial="close" animate="open" exit="close" variants={contextMenuVariants}>
                        <div className="overflow-hidden rounded-lg">
                          <div className="max-h-[50vh] min-w-[300px] overflow-scroll rounded-lg border bg-bolt-elements-background-depth-1 shadow-sm">
                            <FileTree
                              files={files}
                              hideRoot
                              rootFolder={path}
                              collapsed
                              allowFolderSelection
                              selectedFile={`${path}/${segment}`}
                              onFileSelect={(filePath) => {
                                setActiveIndex(null);
                                onFileSelect?.(filePath);
                              }}
                            />
                          </div>
                        </div>
                        <DropdownMenu.Arrow className="fill-border-transparent" />
                      </motion.div>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                )}
              </AnimatePresence>
            </DropdownMenu.Root>
          </div>
        );
      })}
    </div>
  );
});
