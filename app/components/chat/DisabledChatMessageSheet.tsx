import type { ReactNode } from 'react';
import { Sheet } from '@ui/Sheet';
import { AnimatePresence, motion } from 'motion/react';
import { cubicEasingFn } from '~/utils/easings';

/** Why the composer is closed. The live region stays mounted, so a reason that appears is announced. */
export function DisabledChatMessageSheet({ message }: { message: ReactNode | null }) {
  return (
    <div role="status">
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ translateY: '-100%', opacity: 0 }}
            animate={{ translateY: '0%', opacity: 1 }}
            exit={{ translateY: '-100%', opacity: 0 }}
            transition={{ duration: 0.5, ease: cubicEasingFn }}
          >
            <Sheet className="bg-util-accent/10 -mt-2 flex w-full flex-col gap-3 rounded-lg rounded-t-none p-4 shadow backdrop-blur-lg">
              {message}
            </Sheet>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
