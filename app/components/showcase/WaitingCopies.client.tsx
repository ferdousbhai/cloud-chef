import { useEffect, useRef, useState } from 'react';
import { Cross2Icon } from '@radix-ui/react-icons';
import { Spinner } from '@ui/Spinner';
import { RequestError } from '~/lib/json-request';
import { forgetWaitingCopy, loadWaitingCopies, makeWaitingCopy } from '~/lib/showcase-api';

type Waiting = { projectId: string; name: string; sourceName: string };

/**
 * Copies someone asked for from a post before they had a space to build in. Once they have one, each is made here
 * by itself, with a closable tip saying so; one that can't be made yet (the space is still being set up) waits for
 * the next visit.
 */
export function WaitingCopies() {
  const [making, setMaking] = useState<Waiting | null>(null);
  const [made, setMade] = useState<{ name: string; initialId: string } | null>(null);
  const [closed, setClosed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      const copies: Waiting[] = await loadWaitingCopies().catch(() => []);
      for (const copy of copies) {
        setMaking(copy);
        try {
          const result = await makeWaitingCopy(copy.projectId);
          setMade({ name: copy.name, initialId: result.initialId });
        } catch (error) {
          // A space still being set up answers 503: the copy waits for next time. Anything final, it's dropped.
          if (error instanceof RequestError && error.status !== 503 && error.status !== 409 && error.status !== 502) {
            await forgetWaitingCopy(copy.projectId).catch(() => undefined);
          }
          if (error instanceof RequestError && error.status === 503) {
            break;
          }
        }
      }
      setMaking(null);
    })();
  }, []);

  if (closed || (!making && !made)) {
    return null;
  }
  return (
    <div
      role="status"
      className="fixed bottom-5 left-5 z-40 flex max-w-[calc(100vw-2rem)] items-start gap-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-3 text-sm shadow-panel sm:max-w-sm"
    >
      {making ? <Spinner /> : null}
      <p className="min-w-0 flex-1 text-content-primary">
        {making ? (
          <>Making your copy of {making.sourceName}, which you asked for earlier…</>
        ) : made ? (
          <>
            Your copy, {made.name}, is ready.{' '}
            <a href={`/chat/${encodeURIComponent(made.initialId)}`} className="font-medium">
              Open it
            </a>
          </>
        ) : null}
      </p>
      <button
        type="button"
        className="text-content-tertiary hover:text-content-primary"
        aria-label="Close"
        onClick={() => setClosed(true)}
      >
        <Cross2Icon />
      </button>
    </div>
  );
}
