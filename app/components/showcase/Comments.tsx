import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { toast } from 'sonner';
import { DotsHorizontalIcon } from '@radix-ui/react-icons';
import { Menu, MenuItem } from '@ui/Menu';
import { messageOf } from '~/lib/json-request';
import { addComment, deleteComment, loadComments } from '~/lib/showcase-api';
import { COMMENT_MAX, timeAgo, type PostComment } from '~/lib/showcase';
import { Avatar } from './Avatar';
import { PersonLink } from './ShowcaseLinks';
import { ReportDialog } from './PostDialogs';
import { useShowcaseViewer } from './ViewerContext';

/**
 * A post's comments, oldest first, and what adds one. Anyone may read them; commenting needs sign-in and a username.
 * A comment's writer, or whoever manages the post, can delete it; anyone else can report it. The list and the box
 * are separate parts, so a post's page can put the box at the bottom, under its actions.
 */
export function useComments(postId: string, onCount?: (change: number) => void) {
  const { viewer, signedIn } = useShowcaseViewer();
  const [comments, setComments] = useState<PostComment[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The comment just posted here, which its list scrolls to.
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadComments(postId, 0, controller.signal)
      .then((page) => {
        setComments(page.comments);
        setMore(page.more);
      })
      .catch(() => !controller.signal.aborted && setError('Comments couldn’t be loaded.'));
    return () => controller.abort();
  }, [postId]);

  const loadMore = () => {
    const last = comments?.at(-1);
    void loadComments(postId, last?.createdAt ?? 0).then((page) => {
      setComments((current) => [...(current ?? []), ...page.comments]);
      setMore(page.more);
    });
  };

  /** Posts `body`; true once it's posted. */
  const add = (body: string, done: () => void) =>
    signedIn('Sign in to comment.', () => {
      if (viewer?.signedIn && !viewer.me.username) {
        toast.error('Choose a username in Settings first, so people know who commented.');
        return;
      }
      setSending(true);
      addComment(postId, body)
        .then((comment) => {
          setComments((current) => [...(current ?? []), comment]);
          onCount?.(1);
          done();
          setAdded(comment.id);
        })
        .catch((cause) => toast.error(messageOf(cause, 'Your comment couldn’t be posted. Try again.')))
        .finally(() => setSending(false));
    });

  const remove = (comment: PostComment) =>
    deleteComment(comment.id)
      .then(() => {
        setComments((current) => current?.filter((each) => each.id !== comment.id) ?? null);
        onCount?.(-1);
      })
      .catch((cause) => toast.error(messageOf(cause, 'The comment couldn’t be deleted.')));

  return { postId, comments, more, error, sending, added, loadMore, add, remove };
}

type CommentsState = ReturnType<typeof useComments>;

export function CommentList({ state }: { state: CommentsState }) {
  const { viewer, manages } = useShowcaseViewer();
  const [reporting, setReporting] = useState<string | null>(null);
  const me = viewer?.signedIn ? viewer.me.username : null;
  const { comments, error, more } = state;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (state.added) {
      list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
    }
  }, [state.added]);
  return (
    <div className="grid gap-3">
      {error ? <p className="text-sm text-content-tertiary">{error}</p> : null}
      {comments === null && !error ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading comments…
        </p>
      ) : null}
      {comments?.length === 0 ? (
        <p className="text-sm text-content-tertiary">No comments yet. Say what you think.</p>
      ) : null}
      {comments && comments.length > 0 ? (
        <ol ref={list} className="grid gap-3.5" aria-label="Comments">
          {comments.map((comment) => (
            <li key={comment.id} className="group flex min-w-0 items-start gap-2.5">
              <PersonLink username={comment.author.username} className="shrink-0">
                <Avatar name={comment.author.name} image={comment.author.image} size={30} />
              </PersonLink>
              <div className="min-w-0 flex-1 text-sm">
                <p className="wrap-anywhere whitespace-pre-line text-content-primary">
                  <PersonLink
                    username={comment.author.username}
                    className="mr-1.5 font-semibold text-content-primary no-underline hover:underline"
                  >
                    {comment.author.username ?? comment.author.name}
                  </PersonLink>
                  {comment.body}
                </p>
                <p className="mt-0.5 text-xs text-content-tertiary">{timeAgo(comment.createdAt)}</p>
              </div>
              <div className="opacity-60 focus-within:opacity-100 group-hover:opacity-100">
                <Menu
                  buttonProps={{
                    variant: 'subtle',
                    title: 'More for this comment',
                    inline: true,
                    className: '!min-h-7 !px-1.5',
                    icon: <DotsHorizontalIcon />,
                  }}
                >
                  {(me && comment.author.username === me) || manages(state.postId) ? (
                    <MenuItem danger action={() => void state.remove(comment)}>
                      Delete comment
                    </MenuItem>
                  ) : (
                    <MenuItem danger action={() => setReporting(comment.id)}>
                      Report comment
                    </MenuItem>
                  )}
                </Menu>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {more ? (
        <button
          type="button"
          className="justify-self-start text-sm text-content-secondary hover:underline"
          onClick={state.loadMore}
        >
          More comments
        </button>
      ) : null}
      {reporting ? (
        <ReportDialog postId={state.postId} commentId={reporting} onClose={() => setReporting(null)} />
      ) : null}
    </div>
  );
}

export function CommentForm({ state, inputRef }: { state: CommentsState; inputRef?: Ref<HTMLTextAreaElement> }) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (body) {
      state.add(body, () => setText(''));
    }
  };
  return (
    <form className="flex items-end gap-2" onSubmit={submit}>
      <textarea
        ref={inputRef}
        rows={1}
        maxLength={COMMENT_MAX}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            submit(event);
          }
        }}
        placeholder="Add a comment…"
        aria-label="Add a comment"
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
  );
}
