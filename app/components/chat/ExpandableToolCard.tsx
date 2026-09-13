import { CaretDownIcon, CaretUpIcon } from '@radix-ui/react-icons';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cubicEasingFn } from '~/utils/easings';

export function ExpandableToolCard({
  body,
  expanded,
  header,
  onToggle,
}: {
  body?: ReactNode;
  expanded: boolean;
  header: ReactNode;
  onToggle: () => void;
}) {
  return (
    <div className="tool-call-card flex w-full flex-col overflow-hidden rounded-lg border border-bolt-elements-artifacts-borderColor shadow-sm transition-[border-color,box-shadow] duration-150">
      <motion.button
        type="button"
        aria-expanded={expanded}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, ease: cubicEasingFn }}
        className="flex min-w-0 items-stretch overflow-hidden bg-bolt-elements-artifacts-background text-content-primary outline-none transition-colors hover:bg-bolt-elements-artifacts-backgroundHover focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1 p-3.5 px-5 text-left">{header}</div>
        <span className="flex shrink-0 items-center justify-center border-l border-bolt-elements-artifacts-borderColor p-4">
          {expanded ? <CaretUpIcon /> : <CaretDownIcon />}
        </span>
      </motion.button>
      <AnimatePresence>
        {expanded && body && (
          <motion.div
            className="tool-details border-t border-bolt-elements-artifacts-borderColor"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="bg-bolt-elements-actions-background p-5 text-left">{body}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
