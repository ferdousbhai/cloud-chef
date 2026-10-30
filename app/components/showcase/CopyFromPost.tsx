import { createClientOnlyFn } from '@tanstack/react-start';
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { TextInput } from '@ui/TextInput';
import { messageOf } from '~/lib/json-request';
import { waitForCopy } from '~/lib/showcase-api';
import { useShowcaseViewer } from './ViewerContext';

const LazyCopyProjectDialog = lazy(() =>
  import('~/components/projects/CopyProjectDialog.client').then((module) => ({ default: module.CopyProjectDialog })),
);
// The usual copy dialog is the browser's alone; it only ever opens after a click or a return from signing in.
const getCopyProjectDialog = createClientOnlyFn(() => LazyCopyProjectDialog);
const ConnectCloudflareButton = lazy(() =>
  import('./ConnectCloudflareButton').then((module) => ({ default: module.ConnectCloudflareButton })),
);

/** The address that brings someone back to a post with its copy dialog open, once signed in. */
const COPY_PARAM = 'copy';

/**
 * "Make a copy" from a post. Someone signed in with a space to build in gets the usual copy dialog; someone signed in
 * without one has the copy kept waiting, made by itself once they connect a Cloudflare account; a visitor signs in
 * first and comes back here with the dialog open.
 */
export function useCopyFromPost(project: { id: string; name: string; path: string }) {
  const { viewer, signedIn } = useShowcaseViewer();
  // Back from signing in to copy this post: the dialog opens once signed in, until closed.
  const [asked] = useState(
    () =>
      globalThis.location?.pathname === project.path &&
      new URLSearchParams(globalThis.location.search).get(COPY_PARAM) === '1',
  );
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const close = () => {
    setOpen(false);
    setClosed(true);
  };

  // The request comes out of the address, so a reload or a shared link doesn't open it again.
  useEffect(() => {
    if (asked) {
      const url = new URL(window.location.href);
      url.searchParams.delete(COPY_PARAM);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [asked]);

  const start = () =>
    signedIn('Sign in to make your own copy.', () => setOpen(true), `${project.path}?${COPY_PARAM}=1`);

  const CopyProjectDialog = getCopyProjectDialog();
  const dialog =
    (open || (asked && !closed)) && viewer?.signedIn ? (
      viewer.me.hasSpace ? (
        CopyProjectDialog && (
          <Suspense fallback={null}>
            <CopyProjectDialog
              project={{ id: project.id, name: project.name }}
              onOpenProject={(initialId) => window.location.assign(`/chat/${encodeURIComponent(initialId)}`)}
              onClose={close}
            />
          </Suspense>
        )
      ) : (
        <CopyWhenReadyDialog project={project} onClose={close} />
      )
    ) : null;

  return { start, dialog };
}

/**
 * For someone with no space to build in yet: their copy waits, and is made by itself as soon as they connect a
 * Cloudflare account (or join a team). Nothing is copied until then.
 */
function CopyWhenReadyDialog({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [state, setState] = useState<'choosing' | 'saving' | 'waiting'>('choosing');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState('saving');
    setError(null);
    try {
      await waitForCopy(project.id, name.trim() || project.name);
      setState('waiting');
    } catch (cause) {
      setError(messageOf(cause, 'That didn’t work. Try again.'));
      setState('choosing');
    }
  };
  if (state === 'waiting') {
    return (
      <Modal onClose={onClose} title="Your copy is waiting">
        <div className="grid gap-2 text-sm text-content-secondary">
          <p>
            CloudChef makes <span className="font-medium text-content-primary">{name.trim() || project.name}</span> for
            you as soon as you have a space to build in. Connect a Cloudflare account to get one; your copy is made when
            you come back.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Later
          </Button>
          <Suspense fallback={null}>
            <ConnectCloudflareButton />
          </Suspense>
        </div>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose} title="Make a copy" description={project.name}>
      <form className="grid gap-3 text-sm" onSubmit={(event) => void submit(event)}>
        <p className="text-content-secondary">
          You don’t have a space to build in yet. CloudChef can keep your copy waiting and make it, with all its
          history, as soon as you have one.
        </p>
        <label className="grid gap-1">
          <span className="font-medium text-content-primary">Name of your copy</span>
          <TextInput required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {error ? (
          <p role="alert" className="text-content-error wrap-anywhere">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={state === 'saving'} disabled={name.trim() === ''}>
            Keep my copy waiting
          </Button>
        </div>
      </form>
    </Modal>
  );
}
