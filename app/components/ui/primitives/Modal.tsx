import * as Dialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';

export function Modal({
  children,
  onClose,
  title,
  description,
}: {
  children: ReactNode;
  onClose?: () => void;
  title: ReactNode;
  description?: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose?.();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus({ preventScroll: true });
            }
          }}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          className="fixed inset-4 z-50 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-5 shadow-xl focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            {typeof title === 'string' ? (
              <Dialog.Title className="font-semibold text-content-primary">{title}</Dialog.Title>
            ) : (
              <Dialog.Title asChild>
                <div>{title}</div>
              </Dialog.Title>
            )}
            {onClose && (
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="cc-icon-button flex size-8 items-center justify-center text-content-secondary hover:text-content-primary"
                  aria-label="Close dialog"
                >
                  <span aria-hidden>×</span>
                </button>
              </Dialog.Close>
            )}
          </div>
          {description && (
            <Dialog.Description className="mb-3 text-sm text-content-secondary">{description}</Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
