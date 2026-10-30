import * as Dialog from '@radix-ui/react-dialog';
import { lazy, Suspense } from 'react';
import { Loading } from '~/components/Loading';

const CloudflareSignInPrompt = lazy(() =>
  import('~/components/CloudflareSignInPrompt').then((module) => ({ default: module.CloudflareSignInPrompt })),
);

/**
 * Signing in from a public page, to follow, like, comment or copy: the usual sign-in, over the page, returning to it
 * (with `returnTo`, such as the post with its copy dialog open) once signed in.
 */
export function SignInOverlay({ title, returnTo, onClose }: { title: string; returnTo: string; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 top-1/2 z-50 mx-auto max-h-dvh max-w-lg -translate-y-1/2 overflow-y-auto focus:outline-hidden"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Close
            className="absolute right-6 top-9 z-10 flex size-9 items-center justify-center rounded-full text-content-secondary hover:bg-bolt-elements-background-depth-2 hover:text-content-primary"
            aria-label="Close"
          >
            <span aria-hidden>×</span>
          </Dialog.Close>
          <Suspense fallback={<Loading message="Loading sign-in…" />}>
            <CloudflareSignInPrompt title={title} returnTo={returnTo} />
          </Suspense>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
