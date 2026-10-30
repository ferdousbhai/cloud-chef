import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ReelDraftPublicState } from '~/agents/builder-reels';
import { Button } from '~/components/ui/primitives/Button';
import { messageOf } from '~/lib/json-request';
import { base64ToBytes } from '~/lib/hex-digest';
import { reelRefContentType, type ReelBundle, type ReelTimeline } from '~/lib/reel';

/** CloudChef's clip player, the one posts use, loaded only when a clip is in the chat. */
const ReelPlayer = lazy(() => import('~/components/showcase/ReelPlayer'));

/** The clips the agent made in this chat, and what the person can do with one. */
export type ChatReels = {
  reels: readonly ReelDraftPublicState[];
  /** The clip's timeline and files, as the player plays them; null when it can't be read. */
  load: (reelId: string) => Promise<ReelBundle | null>;
  decide: (reelId: string, decision: 'approve' | 'decline') => Promise<void>;
};

const ChatReelsContext = createContext<ChatReels | null>(null);

export function ChatReelsProvider({ value, children }: { value: ChatReels; children: ReactNode }) {
  return <ChatReelsContext.Provider value={value}>{children}</ChatReelsContext.Provider>;
}

/** The clips a command of the agent made, each in its place below the command. */
export function CommandReels({ toolCallId }: { toolCallId: string }) {
  const chat = useContext(ChatReelsContext);
  const reels = chat?.reels.filter((reel) => reel.toolCallId === toolCallId) ?? [];
  if (!chat || reels.length === 0) {
    return null;
  }
  return (
    <>
      {[...reels].reverse().map((reel) => (
        <ReelCard key={reel.reelId} reel={reel} chat={chat} />
      ))}
    </>
  );
}

/**
 * A clip waiting for the person: it plays here, and goes on their post only when they press Approve. Not now puts it
 * aside. Once decided, the card says what became of it.
 */
function ReelCard({ reel, chat }: { reel: ReelDraftPublicState; chat: ChatReels }) {
  const [pending, setPending] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = reel.status === 'waiting' || reel.status === 'posting';
  const playable = usePlayableReel(open ? reel.reelId : null, chat.load);

  const decide = async (decision: 'approve' | 'decline') => {
    setPending(decision);
    setError(null);
    try {
      await chat.decide(reel.reelId, decision);
    } catch (failure) {
      setError(messageOf(failure, 'That didn’t go through. Try again.'));
    } finally {
      setPending(null);
    }
  };

  return (
    // A command's frame, without its height limit: the clip is shown whole.
    <div className="overflow-hidden rounded-md border border-bolt-elements-artifacts-borderColor bg-bolt-elements-background-depth-1 text-xs text-content-primary">
      <div className="space-y-3 px-3 py-2.5" data-testid="chat-reel">
        <p className="text-sm font-medium text-content-primary">A short clip of your app for your post</p>
        {open ? (
          <div className="aspect-[16/10] w-full max-w-xl overflow-hidden rounded-lg bg-[#0c0d12]">
            {playable === 'failed' ? (
              <p className="flex size-full items-center justify-center p-4 text-sm text-white/80">
                The clip couldn’t be shown here.
              </p>
            ) : playable ? (
              <Suspense fallback={null}>
                <ReelPlayer timeline={playable.timeline} fileUrl={playable.url} title="Your app" />
              </Suspense>
            ) : null}
          </div>
        ) : null}
        <ReelStatus reel={reel} />
        {reel.status === 'waiting' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={pending !== null}
              loading={pending === 'approve'}
              aria-busy={pending === 'approve'}
              onClick={() => void decide('approve')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="neutral"
              disabled={pending !== null}
              loading={pending === 'decline'}
              aria-busy={pending === 'decline'}
              onClick={() => void decide('decline')}
            >
              Not now
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-xs text-bolt-elements-icon-error">{error}</p> : null}
      </div>
    </div>
  );
}

function ReelStatus({ reel }: { reel: ReelDraftPublicState }) {
  const seconds = `${Math.max(1, Math.round(reel.seconds))} seconds`;
  switch (reel.status) {
    case 'waiting':
      return (
        <p className="text-xs leading-5 text-content-secondary" role="status">
          {reel.note ?? `${seconds}. It goes on your post only if you approve.`}
        </p>
      );
    case 'posting':
      return (
        <p className="text-xs leading-5 text-content-secondary" role="status">
          Putting it on your post…
        </p>
      );
    case 'posted':
      return (
        <p className="text-sm text-content-primary" role="status">
          {reel.note ?? 'It’s on your post.'}{' '}
          <a href={reel.postPath} target="_blank" rel="noopener noreferrer" className="text-content-link underline">
            See your post
          </a>
        </p>
      );
    case 'declined':
      return (
        <p className="text-xs text-content-secondary" role="status">
          Not posted. Ask for a new clip any time.
        </p>
      );
  }
}

type PlayableReel = { timeline: ReelTimeline; url: (ref: string) => string };

/** A clip's files as addresses this page made from their bytes, for as long as the card shows it. */
function usePlayableReel(reelId: string | null, load: ChatReels['load']): PlayableReel | 'failed' | null {
  const [playable, setPlayable] = useState<PlayableReel | 'failed' | null>(null);
  useEffect(() => {
    if (!reelId) {
      return;
    }
    let current = true;
    const made: string[] = [];
    load(reelId)
      .then((bundle) => {
        if (!current) {
          return;
        }
        if (!bundle) {
          setPlayable('failed');
          return;
        }
        const urls = new Map(
          Object.entries(bundle.files).map(([ref, encoded]) => {
            const url = URL.createObjectURL(new Blob([base64ToBytes(encoded)], { type: reelRefContentType(ref) }));
            made.push(url);
            return [ref, url];
          }),
        );
        setPlayable({ timeline: bundle.timeline, url: (ref) => urls.get(ref) ?? '' });
      })
      .catch(() => {
        if (current) {
          setPlayable('failed');
        }
      });
    return () => {
      current = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [reelId, load]);
  return playable;
}
