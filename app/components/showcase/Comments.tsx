import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { toast } from 'sonner';
import { DotsHorizontalIcon, DrawingPinFilledIcon, LockClosedIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Menu, MenuItem, MenuSeparator } from '@ui/Menu';
import { messageOf } from '~/lib/json-request';
import {
  acceptOfferedChange,
  addReply,
  changeThread,
  deleteComment,
  loadOfferedChange,
  loadReplies,
  loadThreads,
  type OfferedChange,
  setThreadFollowing,
  startThread,
  type MentionAnswer,
  type ThreadChange,
} from '~/lib/showcase-api';
import { COMMENT_MAX, timeAgo, type PostComment, type PostThread } from '~/lib/showcase';
import { classNames } from '~/utils/classNames';
import { Avatar } from './Avatar';
import { PersonLink } from './ShowcaseLinks';
import { CommentMarkdown } from './CommentMarkdown';
import { ReportDialog } from './PostDialogs';
import { useShowcaseViewer } from './ViewerContext';

/** While CloudChef answers in a thread, the list is read again this often to show its reply. */
const WORKING_REFRESH_MS = 8_000;

/**
 * A post's comment threads (docs/proposals/comment-threads.md): each top-level comment starts a thread, numbered on
 * the post, with replies under it. A thread is open, on its way, or closed with a reason; pinned threads come first
 * and closed ones fold to a line. Anyone may read them; commenting needs sign-in and a username. `@cloudchef` in a
 * comment asks CloudChef, which answers in the thread. The list and the box are separate parts, so a post's page can
 * put the box at the bottom, under its actions.
 */
export function useThreads(postId: string, onCount?: (change: number) => void) {
  const { viewer, signedIn } = useShowcaseViewer();
  const [threads, setThreads] = useState<PostThread[] | null>(null);
  const [open, setOpen] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<PostThread | null>(null);
  // The comment just posted here, which its list scrolls to.
  const [added, setAdded] = useState<string | null>(null);
  const signedInId = viewer?.signedIn ? viewer.me.username : null;

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      loadThreads(postId, signal)
        .then((page) => {
          setThreads((current) => keepExpandedReplies(current, page.threads));
          setOpen(page.open);
          setError(null);
        })
        .catch(() => !signal?.aborted && setError('Comments couldn’t be loaded.')),
    [postId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
    // Signing in changes what each thread lets the viewer do.
  }, [refresh, signedInId]);

  const working = threads?.some((thread) => thread.working) ?? false;
  useEffect(() => {
    if (!working) {
      return;
    }
    const timer = setInterval(() => void refresh(), WORKING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [working, refresh]);

  const replace = (thread: PostThread) => {
    setThreads(
      (current) =>
        current?.map((each) =>
          each.id === thread.id
            ? { ...thread, replies: each.replies.length > thread.replies.length ? each.replies : thread.replies }
            : each,
        ) ?? null,
    );
  };

  const tellMention = (mention: MentionAnswer) => {
    if (mention?.status === 'no_space') {
      toast.error(mention.message ?? 'Choose where to build first, so CloudChef can work in your own space.', {
        action: { label: 'Choose', onClick: () => window.location.assign('/') },
      });
    } else if (mention?.status === 'failed') {
      toast.error(mention.message ?? 'CloudChef couldn’t start. Try again.');
    } else if (mention?.status === 'queued') {
      toast(mention.message ?? 'CloudChef will answer this once it finishes what it’s working on now.');
    }
  };

  /** Posts `body` as a new thread, or as a reply in the thread being replied to. */
  const add = (body: string, done: () => void) =>
    signedIn('Sign in to comment.', () => {
      if (viewer?.signedIn && !viewer.me.username) {
        toast.error('Choose a username in Settings first, so people know who commented.');
        return;
      }
      setSending(true);
      const thread = replyingTo;
      const posting = thread
        ? addReply(thread.id, body).then(({ comment, mention }) => {
            setThreads(
              (current) =>
                current?.map((each) =>
                  // The list read again while this was posted may hold it already.
                  each.id === thread.id && !each.replies.some((reply) => reply.id === comment.id)
                    ? {
                        ...each,
                        replies: [...each.replies, comment],
                        replyCount: each.replyCount + 1,
                        working: each.working || mention?.status === 'working' || mention?.status === 'queued',
                      }
                    : each,
                ) ?? null,
            );
            setAdded(comment.id);
            tellMention(mention);
          })
        : startThread(postId, body).then(({ thread: started, mention }) => {
            setThreads((current) => [
              ...(current ?? []).filter((each) => each.pinned && each.id !== started.id),
              { ...started, working: started.working || mention?.status === 'working' || mention?.status === 'queued' },
              ...(current ?? []).filter((each) => !each.pinned && each.id !== started.id),
            ]);
            setOpen((count) => count + 1);
            setAdded(started.id);
            tellMention(mention);
          });
      posting
        .then(() => {
          onCount?.(1);
          setReplyingTo(null);
          done();
        })
        .catch((cause) => toast.error(messageOf(cause, 'Your comment couldn’t be posted. Try again.')))
        .finally(() => setSending(false));
    });

  const change = (thread: PostThread, what: ThreadChange) =>
    changeThread(thread.id, what)
      .then((changed) => {
        replace(changed);
        void refresh();
      })
      .catch((cause) => toast.error(messageOf(cause, 'That didn’t work. Try again.')));

  /** Accepts the change a thread offers: it goes into the project and is published. Whether it did. */
  const accept = (thread: PostThread) =>
    acceptOfferedChange(thread.id).then(
      (changed) => {
        replace(changed);
        setOpen((count) => Math.max(0, count - 1));
        toast.success('Accepted. It’s being published now.');
        return true;
      },
      (cause) => {
        toast.error(messageOf(cause, 'The change couldn’t be brought in. Try again.'));
        return false;
      },
    );

  /** Declines the change a thread offers: the reason, if one is given, is a reply, and the thread closes. */
  const decline = async (thread: PostThread, reason: string) => {
    try {
      if (reason.trim()) {
        await addReply(thread.id, reason.trim());
        onCount?.(1);
      }
      replace(await changeThread(thread.id, { action: 'close', reason: 'not_planned' }));
      void refresh();
    } catch (cause) {
      toast.error(messageOf(cause, 'That didn’t work. Try again.'));
    }
  };

  const follow = (thread: PostThread, following: boolean) =>
    setThreadFollowing(thread.id, following)
      .then(() => replace({ ...thread, viewer: thread.viewer ? { ...thread.viewer, following } : thread.viewer }))
      .catch((cause) => toast.error(messageOf(cause, 'That didn’t work. Try again.')));

  const remove = (comment: PostComment, thread: PostThread) =>
    deleteComment(comment.id)
      .then(() => {
        if (comment.id === thread.id) {
          setThreads((current) => current?.filter((each) => each.id !== thread.id) ?? null);
          onCount?.(-(1 + thread.replyCount));
          if (thread.state === 'open') {
            setOpen((count) => Math.max(0, count - 1));
          }
        } else {
          setThreads(
            (current) =>
              current?.map((each) =>
                each.id === thread.id
                  ? {
                      ...each,
                      replies: each.replies.filter((reply) => reply.id !== comment.id),
                      replyCount: Math.max(0, each.replyCount - 1),
                    }
                  : each,
              ) ?? null,
          );
          onCount?.(-1);
        }
      })
      .catch((cause) => toast.error(messageOf(cause, 'The comment couldn’t be deleted.')));

  const showAllReplies = (thread: PostThread) =>
    loadReplies(thread.id)
      .then((replies) => replace({ ...thread, replies }))
      .catch(() => toast.error('The replies couldn’t be loaded.'));

  /** A thread started elsewhere on the page, such as a suggestion from a copy. */
  const prepend = (thread: PostThread) => {
    setThreads((current) => [
      ...(current ?? []).filter((each) => each.pinned),
      thread,
      ...(current ?? []).filter((each) => !each.pinned && each.id !== thread.id),
    ]);
    setOpen((count) => count + 1);
    setAdded(thread.id);
    onCount?.(1);
  };

  return {
    postId,
    threads,
    open,
    error,
    sending,
    added,
    replyingTo,
    setReplyingTo,
    add,
    change,
    accept,
    decline,
    follow,
    remove,
    showAllReplies,
    prepend,
  };
}

/** Keeps replies someone opened with "Show all" when the list is read again. */
function keepExpandedReplies(current: PostThread[] | null, next: PostThread[]): PostThread[] {
  if (!current) {
    return next;
  }
  const before = new Map(current.map((thread) => [thread.id, thread]));
  return next.map((thread) => {
    const old = before.get(thread.id);
    return old && old.replies.length > thread.replies.length && old.replyCount === thread.replyCount
      ? { ...thread, replies: old.replies }
      : thread;
  });
}

export type ThreadsState = ReturnType<typeof useThreads>;

export function ThreadList({ state, onReply }: { state: ThreadsState; onReply: () => void }) {
  const { threads, error } = state;
  const [reporting, setReporting] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [sameAsFor, setSameAsFor] = useState<PostThread | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (state.added) {
      document.getElementById(`comment-${state.added}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [state.added]);

  const goTo = (number: number) => {
    const thread = threads?.find((each) => each.number === number);
    if (thread) {
      setUnfolded((current) => new Set(current).add(thread.id));
      requestAnimationFrame(() => document.getElementById(`thread-${number}`)?.scrollIntoView({ block: 'start' }));
    }
  };

  return (
    <div className="grid gap-3">
      {error ? <p className="text-sm text-content-tertiary">{error}</p> : null}
      {threads === null && !error ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading comments…
        </p>
      ) : null}
      {threads?.length === 0 ? (
        <p className="text-sm text-content-tertiary">No comments yet. Say what you think, or ask for something.</p>
      ) : null}
      {threads && threads.length > 0 ? (
        <ol ref={list} className="grid grid-cols-[minmax(0,1fr)] gap-4" aria-label="Comments">
          {threads.map((thread) =>
            thread.state === 'closed' && !thread.pinned && !unfolded.has(thread.id) ? (
              <li key={thread.id} id={`thread-${thread.number}`}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-baseline gap-2 text-left text-sm text-content-tertiary hover:text-content-secondary"
                  onClick={() => setUnfolded((current) => new Set(current).add(thread.id))}
                  aria-expanded={false}
                >
                  <span className="shrink-0 tabular-nums">#{thread.number}</span>
                  <span className="min-w-0 flex-1 truncate">{thread.first.body}</span>
                  <span className="shrink-0 text-xs">{closedWords(thread, true)}</span>
                </button>
              </li>
            ) : (
              <Thread
                key={thread.id}
                thread={thread}
                state={state}
                goTo={goTo}
                onReply={() => {
                  state.setReplyingTo(thread);
                  onReply();
                }}
                onReport={setReporting}
                onSameAs={() => setSameAsFor(thread)}
                onFold={
                  thread.state === 'closed' && unfolded.has(thread.id)
                    ? () =>
                        setUnfolded((current) => {
                          const next = new Set(current);
                          next.delete(thread.id);
                          return next;
                        })
                    : null
                }
              />
            ),
          )}
        </ol>
      ) : null}
      {reporting ? (
        <ReportDialog postId={state.postId} commentId={reporting} onClose={() => setReporting(null)} />
      ) : null}
      {sameAsFor ? (
        <SameAsForm
          thread={sameAsFor}
          others={(threads ?? []).filter((each) => each.id !== sameAsFor.id)}
          onDone={(number) => {
            void state.change(sameAsFor, { action: 'close', reason: 'duplicate', sameAs: number });
            setSameAsFor(null);
          }}
          onCancel={() => setSameAsFor(null)}
        />
      ) : null}
    </div>
  );
}

/** "Changed in the update of Nov 20", "Not planned", "Same as #3"; `short` for a folded line: "Changed Nov 20". */
function closedWords(thread: PostThread, short = false): string {
  switch (thread.closeReason) {
    case 'changed':
      return thread.stateAt
        ? `${short ? 'Changed' : 'Changed in the update of'} ${new Date(thread.stateAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : 'Changed';
    case 'not_planned':
      return 'Not planned';
    case 'duplicate':
      return thread.sameAs ? `Same as #${thread.sameAs}` : 'Closed';
    default:
      return 'Closed';
  }
}

function StateLine({ thread }: { thread: PostThread }) {
  if (thread.state === 'open') {
    return null;
  }
  const words =
    thread.state === 'on_its_way'
      ? 'On its way: changed, and live with the next update'
      : thread.state === 'closed'
        ? closedWords(thread)
        : null;
  return (
    <div className="mt-1 grid gap-0.5 text-xs">
      {words ? (
        <p
          className={classNames(
            'font-medium',
            thread.state === 'on_its_way' ? 'text-(--cc-content-link)' : 'text-content-secondary',
          )}
        >
          {words}
        </p>
      ) : null}
    </div>
  );
}

function Thread({
  thread,
  state,
  goTo,
  onReply,
  onReport,
  onSameAs,
  onFold,
}: {
  thread: PostThread;
  state: ThreadsState;
  goTo: (number: number) => void;
  onReply: () => void;
  onReport: (commentId: string) => void;
  onSameAs: () => void;
  onFold: (() => void) | null;
}) {
  const hidden = thread.replyCount - thread.replies.length;
  return (
    <li id={`thread-${thread.number}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 scroll-mt-3">
      <Comment
        comment={thread.first}
        thread={thread}
        state={state}
        goTo={goTo}
        onReport={onReport}
        badge={
          <span className="inline-flex items-center gap-1 text-content-tertiary">
            #{thread.number}
            {thread.pinned ? <DrawingPinFilledIcon aria-label="Pinned" className="size-3" /> : null}
            {thread.locked ? <LockClosedIcon aria-label="Locked" className="size-3" /> : null}
          </span>
        }
        extra={
          <>
            {thread.suggestion ? (
              <p className="mt-1 text-xs text-content-secondary">
                {thread.suggestion.ownChange ? (
                  'A change offered to this project'
                ) : (
                  <>
                    A change suggested from{' '}
                    {thread.suggestion.path ? (
                      <a href={thread.suggestion.path}>{thread.suggestion.name}</a>
                    ) : (
                      thread.suggestion.name
                    )}
                  </>
                )}
                {thread.suggestion.siteUrl ? (
                  <>
                    {' · '}
                    <a href={thread.suggestion.siteUrl} target="_blank" rel="noopener noreferrer">
                      Try it
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {thread.suggestion?.ownChange && thread.state === 'open' && thread.viewer?.canEdit ? (
              <OfferedChangeDecision thread={thread} state={state} />
            ) : null}
            {thread.onEarlierVersion && thread.state === 'open' ? (
              <p className="mt-1 text-xs text-content-tertiary">On an earlier version</p>
            ) : null}
            <StateLine thread={thread} />
          </>
        }
        actions={
          <>
            {!thread.locked || thread.viewer?.canEdit ? (
              <button type="button" className="font-semibold hover:underline" onClick={onReply}>
                Reply
              </button>
            ) : null}
            {onFold ? (
              <button type="button" className="hover:underline" onClick={onFold}>
                Fold
              </button>
            ) : null}
          </>
        }
        menu={<ThreadMenuItems thread={thread} state={state} onSameAs={onSameAs} />}
      />
      {thread.replies.length > 0 || hidden > 0 || thread.working ? (
        <ol className="ml-10 grid grid-cols-[minmax(0,1fr)] gap-2.5" aria-label={`Replies to #${thread.number}`}>
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                className="text-xs font-semibold text-content-secondary hover:underline"
                onClick={() => void state.showAllReplies(thread)}
              >
                Show {hidden} earlier {hidden === 1 ? 'reply' : 'replies'}
              </button>
            </li>
          ) : null}
          {thread.replies.map((reply) => (
            <li key={reply.id}>
              <Comment comment={reply} thread={thread} state={state} goTo={goTo} onReport={onReport} size={26} />
            </li>
          ))}
          {thread.working ? (
            <li>
              <CloudChefWorking />
            </li>
          ) : null}
        </ol>
      ) : null}
    </li>
  );
}

/**
 * For someone who can edit the project, on a thread that offers a change made on it: Accept shows the files it
 * changes first, then puts it into the project and publishes it; Decline closes the thread, with a reason as a reply.
 */
function OfferedChangeDecision({ thread, state }: { thread: PostThread; state: ThreadsState }) {
  const [step, setStep] = useState<'idle' | 'loading' | 'review' | 'declining'>('idle');
  const [change, setChange] = useState<OfferedChange | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const by = thread.first.author.name || thread.first.author.username;

  const review = () => {
    setStep('loading');
    loadOfferedChange(thread.id).then(
      (loaded) => {
        setChange(loaded);
        setStep('review');
      },
      (cause) => {
        toast.error(messageOf(cause, 'The change couldn’t be read just now. Try again.'));
        setStep('idle');
      },
    );
  };
  const run = (work: Promise<unknown>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };

  if (step === 'declining') {
    return (
      <form
        className="mt-2 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run(state.decline(thread, reason));
        }}
      >
        <textarea
          rows={2}
          autoFocus
          maxLength={COMMENT_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={`Tell ${by} why (optional)`}
          aria-label="Why you’re declining"
          className="w-full resize-y rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2 text-sm text-content-primary placeholder:text-content-tertiary focus:border-(--cc-accent) focus:outline-hidden"
        />
        <div className="flex gap-2">
          <Button type="submit" size="xs" variant="neutral" loading={busy}>
            Decline
          </Button>
          <Button size="xs" variant="subtle" disabled={busy} onClick={() => setStep('idle')}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  if (step === 'review' && change) {
    return (
      <div className="mt-2 grid gap-2 text-xs text-content-secondary">
        <ul aria-label="Files this changes">
          {change.changed.map((file) => (
            <li key={file.path} className="truncate">
              <span className="font-mono text-content-primary">{file.path}</span> {file.change}
            </li>
          ))}
        </ul>
        <p>{change.note}</p>
        <div className="flex gap-2">
          {change.acceptable ? (
            <Button size="xs" loading={busy} onClick={() => run(state.accept(thread))}>
              Accept and publish
            </Button>
          ) : null}
          <Button size="xs" variant="subtle" disabled={busy} onClick={() => setStep('idle')}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 flex gap-2">
      <Button size="xs" loading={step === 'loading'} onClick={review}>
        Accept
      </Button>
      <Button size="xs" variant="neutral" disabled={step === 'loading'} onClick={() => setStep('declining')}>
        Decline
      </Button>
    </div>
  );
}

/** Where CloudChef's reply will be, while it works on it: its picture and three dots that rise in turn. */
function CloudChefWorking() {
  return (
    <div className="flex items-center gap-2.5" role="status">
      <img src="/cloudchef-logo.svg" alt="" width={26} height={26} className="shrink-0 rounded-full" />
      <span className="text-sm font-semibold text-content-primary">CloudChef</span>
      <span className="showcase-working" aria-label="is working on this">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function Comment({
  comment,
  thread,
  state,
  goTo,
  onReport,
  badge,
  extra,
  actions,
  menu,
  size = 30,
}: {
  comment: PostComment;
  thread: PostThread;
  state: ThreadsState;
  goTo: (number: number) => void;
  onReport: (commentId: string) => void;
  badge?: ReactNode;
  extra?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  size?: number;
}) {
  const { viewer, manages } = useShowcaseViewer();
  const me = viewer?.signedIn ? viewer.me.username : null;
  const mine = me !== null && comment.author.username === me;
  const canDelete = mine || manages(state.postId) || Boolean(thread.viewer?.canEdit);
  return (
    <div id={`comment-${comment.id}`} className="group flex min-w-0 items-start gap-2.5">
      {comment.byAgent ? (
        <img src="/cloudchef-logo.svg" alt="" width={size} height={size} className="shrink-0 rounded-full" />
      ) : (
        <PersonLink username={comment.author.username} className="shrink-0">
          <Avatar name={comment.author.name} image={comment.author.image} size={size} />
        </PersonLink>
      )}
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-content-primary">
          {comment.byAgent ? (
            <span className="font-semibold">CloudChef</span>
          ) : (
            <PersonLink
              username={comment.author.username}
              className="font-semibold text-content-primary no-underline hover:underline"
            >
              {comment.author.username ?? comment.author.name}
            </PersonLink>
          )}
        </p>
        <div className="mt-0.5 text-content-primary">
          <CommentMarkdown text={comment.body} goTo={goTo} />
        </div>
        {extra}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-content-tertiary">
          {badge}
          <span>{timeAgo(comment.createdAt)}</span>
          {comment.byAgent ? (
            <span>
              asked by{' '}
              <PersonLink username={comment.author.username} className="text-content-tertiary">
                @{comment.author.username ?? comment.author.name}
              </PersonLink>
            </span>
          ) : null}
          {actions}
        </p>
      </div>
      <div className="opacity-60 focus-within:opacity-100 group-hover:opacity-100">
        <Menu
          buttonProps={{
            variant: 'subtle',
            title: comment.id === thread.id ? 'More for this thread' : 'More for this comment',
            inline: true,
            className: '!min-h-7 !px-1.5',
            icon: <DotsHorizontalIcon />,
          }}
        >
          {menu}
          {canDelete ? (
            <MenuItem danger action={() => void state.remove(comment, thread)}>
              {comment.id === thread.id ? 'Delete thread' : 'Delete comment'}
            </MenuItem>
          ) : null}
          {!mine ? (
            <MenuItem danger action={() => onReport(comment.id)}>
              Report comment
            </MenuItem>
          ) : null}
        </Menu>
      </div>
    </div>
  );
}

function ThreadMenuItems({
  thread,
  state,
  onSameAs,
}: {
  thread: PostThread;
  state: ThreadsState;
  onSameAs: () => void;
}) {
  const can = thread.viewer;
  if (!can) {
    return null;
  }
  return (
    <>
      {can.canClose && thread.state !== 'closed' ? (
        <>
          <MenuItem action={() => void state.change(thread, { action: 'close', reason: 'changed' })}>
            Close: it’s changed
          </MenuItem>
          <MenuItem action={() => void state.change(thread, { action: 'close', reason: 'not_planned' })}>
            Close: not planned
          </MenuItem>
          <MenuItem action={onSameAs}>Close: same as another…</MenuItem>
        </>
      ) : null}
      {can.canClose && thread.state !== 'open' ? (
        <MenuItem action={() => void state.change(thread, { action: 'reopen' })}>Open again</MenuItem>
      ) : null}
      {can.canEdit ? (
        <>
          <MenuItem action={() => void state.change(thread, { action: 'pin', pinned: !thread.pinned })}>
            {thread.pinned ? 'Unpin' : 'Pin to the top'}
          </MenuItem>
          <MenuItem action={() => void state.change(thread, { action: 'lock', locked: !thread.locked })}>
            {thread.locked ? 'Unlock' : 'Lock replies'}
          </MenuItem>
        </>
      ) : null}
      <MenuItem action={() => void state.follow(thread, !can.following)}>{can.following ? 'Mute' : 'Follow'}</MenuItem>
      <MenuSeparator />
    </>
  );
}

/** Picks the thread a closed one is the same as. */
function SameAsForm({
  thread,
  others,
  onDone,
  onCancel,
}: {
  thread: PostThread;
  others: PostThread[];
  onDone: (number: number) => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={`Close #${thread.number} as the same as another`}
      className="grid gap-2 rounded-md border border-bolt-elements-borderColor p-3 text-sm"
    >
      <p className="text-content-secondary">#{thread.number} is the same as:</p>
      <ul className="grid max-h-48 gap-1 overflow-y-auto">
        {others.map((other) => (
          <li key={other.id}>
            <button
              type="button"
              className="flex w-full min-w-0 gap-2 text-left hover:underline"
              onClick={() => onDone(other.number)}
            >
              <span className="shrink-0 tabular-nums text-content-tertiary">#{other.number}</span>
              <span className="truncate">{other.first.body}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="justify-self-start text-content-secondary hover:underline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

type Suggestion = { insert: string; label: string; hint: string };

/** What `@` or `#` before the cursor could become: CloudChef and the thread's people, or the post's threads. */
function useSuggestions(state: ThreadsState, text: string, cursor: number) {
  return useMemo((): { start: number; options: Suggestion[] } | null => {
    const before = text.slice(0, cursor);
    const match = /(?:^|\s)([@#])([a-z0-9-]*)$/i.exec(before);
    if (!match) {
      return null;
    }
    const [, sign, typed] = match;
    const start = cursor - typed.length - 1;
    const lower = typed.toLowerCase();
    if (sign === '#') {
      const options = (state.threads ?? [])
        .filter((thread) => String(thread.number).startsWith(lower))
        .slice(0, 5)
        .map((thread) => ({ insert: `#${thread.number}`, label: `#${thread.number}`, hint: thread.first.body }));
      return options.length > 0 ? { start, options } : null;
    }
    const people = new Map<string, string>();
    const thread = state.replyingTo;
    for (const comment of thread ? [thread.first, ...thread.replies] : []) {
      if (comment.author.username && !comment.byAgent) {
        people.set(comment.author.username, comment.author.name);
      }
    }
    const options: Suggestion[] = [
      { insert: '@cloudchef', label: '@cloudchef', hint: 'Ask CloudChef' },
      ...[...people].map(([username, name]) => ({ insert: `@${username}`, label: `@${username}`, hint: name })),
    ]
      .filter((option) => option.insert.slice(1).startsWith(lower))
      .slice(0, 6);
    return options.length > 0 ? { start, options } : null;
  }, [state.threads, state.replyingTo, text, cursor]);
}

export function CommentForm({
  state,
  inputRef,
}: {
  state: ThreadsState;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState(0);
  const own = useRef<HTMLTextAreaElement | null>(null);
  const box = inputRef ?? own;
  const suggestions = useSuggestions(state, text, cursor);
  const highlighted = suggestions ? Math.min(chosen, suggestions.options.length - 1) : 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (body) {
      state.add(body, () => setText(''));
    }
  };
  const take = (option: Suggestion) => {
    if (!suggestions) {
      return;
    }
    const next = `${text.slice(0, suggestions.start)}${option.insert} ${text.slice(cursor)}`;
    const at = suggestions.start + option.insert.length + 1;
    setText(next);
    setCursor(at);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
    });
  };
  const replying = state.replyingTo;
  return (
    <div className="relative">
      {replying ? (
        <p className="flex items-center gap-2 pt-2 text-xs text-content-secondary">
          <span className="min-w-0 flex-1 truncate">
            Replying to #{replying.number}: {replying.first.body}
          </span>
          <button type="button" className="shrink-0 hover:underline" onClick={() => state.setReplyingTo(null)}>
            Cancel
          </button>
        </p>
      ) : null}
      {suggestions ? (
        <ul
          role="listbox"
          aria-label="Suggestions"
          className="absolute bottom-full left-0 z-10 mb-1 grid w-full max-w-xs gap-0.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1 text-sm shadow-lg"
        >
          {suggestions.options.map((option, index) => (
            <li key={option.insert} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                className={classNames(
                  'flex w-full min-w-0 items-baseline gap-2 rounded px-2 py-1.5 text-left',
                  index === chosen
                    ? 'bg-bolt-elements-background-depth-3'
                    : 'hover:bg-bolt-elements-background-depth-2',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => take(option)}
              >
                <span className="shrink-0 font-semibold text-content-primary">{option.label}</span>
                <span className="min-w-0 truncate text-xs text-content-tertiary">{option.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="flex items-end gap-2" onSubmit={submit}>
        <textarea
          ref={box}
          rows={1}
          maxLength={COMMENT_MAX}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(event.target.selectionStart);
            setChosen(0);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (suggestions) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setChosen((highlighted + step + suggestions.options.length) % suggestions.options.length);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                take(suggestions.options[highlighted]);
                return;
              }
            }
            if (event.key === 'Escape' && state.replyingTo) {
              state.setReplyingTo(null);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              submit(event);
            }
          }}
          placeholder={replying ? 'Reply, or ask @cloudchef…' : 'Add a comment, or ask @cloudchef…'}
          aria-label={replying ? `Reply to #${replying.number}` : 'Add a comment'}
          className="max-h-32 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-sm text-content-primary placeholder:text-content-tertiary focus:outline-hidden"
        />
        <button
          type="submit"
          disabled={state.sending || text.trim() === ''}
          className="min-h-10 px-1 text-sm font-semibold text-(--cc-content-link) disabled:opacity-40"
        >
          Post
        </button>
      </form>
    </div>
  );
}
