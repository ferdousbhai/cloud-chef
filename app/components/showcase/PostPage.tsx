import { useRef, useState, useSyncExternalStore } from 'react';
import { classNames } from '~/utils/classNames';
import type { PostView } from '~/lib/showcase';
import { timeAgo } from '~/lib/showcase';
import { Avatar } from './Avatar';
import { Caption } from './Caption';
import { CommentForm, ThreadList, useThreads } from './Comments';
import { CopiesDialog } from './CopiesDialog';
import { useCopyFromPost } from './CopyFromPost';
import { PostActions } from './PostActions';
import { PostMedia } from './PostMedia';
import { PostMenu } from './PostMenu';
import { PersonLink } from './ShowcaseLinks';
import { ShowcaseNotice } from './ShowcaseShell';
import { ShowcaseViewerProvider, useShowcaseViewer } from './ViewerContext';

/**
 * A post's own page, `/<owner>/<slug>`, the project's address on CloudChef: the picture large, and beside
 * it who made it, the caption and comments, then the actions and a box to comment. On a phone they stack, picture
 * first.
 */
export function PostPage({ post }: { post: PostView }) {
  return (
    <ShowcaseViewerProvider postIds={[post.id]}>
      <PostPageContent initial={post} />
    </ShowcaseViewerProvider>
  );
}

function PostPageContent({ initial }: { initial: PostView }) {
  const [post, setPost] = useState(initial);
  const [gone, setGone] = useState(false);
  const commentBox = useRef<HTMLTextAreaElement>(null);
  const copy = useCopyFromPost({ id: post.projectId, name: post.title, path: post.path });
  const [showCopies, setShowCopies] = useState(false);
  const comments = useThreads(post.id, (change) =>
    setPost((current) => ({ ...current, commentCount: current.commentCount + change })),
  );
  if (gone) {
    return (
      <ShowcaseNotice title="This post isn’t on your page any more.">
        <p>
          <PersonLink username={post.author.username}>Back to your page</PersonLink>
        </p>
      </ShowcaseNotice>
    );
  }
  const menu = (
    <PostMenu
      post={post}
      onCaption={(caption) => setPost({ ...post, caption })}
      onGone={() => setGone(true)}
      onReelRemoved={() => setPost({ ...post, reel: null })}
    />
  );
  const when = timeAgo(post.shownAt);
  return (
    <main className="mx-auto w-full max-w-6xl px-0 pb-16 sm:px-6 sm:pt-8">
      <article
        className="showcase-card overflow-hidden max-sm:rounded-none max-sm:border-x-0 md:grid md:h-[min(680px,calc(100dvh-8rem))] md:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]"
        aria-label={`${post.title}, by ${post.author.name}`}
      >
        <header className="flex items-center gap-2.5 px-3 py-2.5 md:hidden">
          <AuthorLine post={post} />
          {menu}
        </header>
        <div className="flex items-center justify-center bg-[#0c0d12] md:h-full">
          <PostApp post={post} />
        </div>
        <div className="flex min-h-0 flex-col md:border-l md:border-bolt-elements-borderColor">
          <header className="hidden items-center gap-2.5 border-b border-bolt-elements-borderColor px-4 py-3 md:flex">
            <AuthorLine post={post} />
            {menu}
          </header>
          <div className="order-2 grid gap-1 px-3 pt-1.5 md:order-3 md:border-t md:border-bolt-elements-borderColor md:px-4 md:pt-2">
            <PostActions
              post={post}
              onComment={() => {
                comments.setReplyingTo(null);
                commentBox.current?.focus();
              }}
              onCopy={copy.start}
              onCopies={() => setShowCopies(true)}
            />
            <p className="text-xs text-content-tertiary">
              {post.updated ? 'Updated' : 'Posted'} {/^\d/.test(when) ? `${when} ago` : when}
            </p>
          </div>
          <div
            id="comments"
            className="order-3 grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-3 py-3 md:order-2 md:px-4"
          >
            <div className="grid gap-1">
              <h1 className="text-base font-semibold text-content-primary">{post.title}</h1>
              {post.caption ? <Caption username={post.author.username} text={post.caption} folded={false} /> : null}
            </div>
            <ThreadList state={comments} onReply={() => commentBox.current?.focus()} />
          </div>
          <div className="order-4 border-t border-bolt-elements-borderColor px-3 md:px-4">
            <CommentForm state={comments} inputRef={commentBox} />
          </div>
        </div>
      </article>
      {copy.dialog}
      {showCopies ? (
        <CopiesDialog
          postId={post.id}
          title={post.title}
          onSuggested={(thread) => {
            setShowCopies(false);
            comments.prepend(thread);
          }}
          onClose={() => setShowCopies(false)}
        />
      ) : null}
    </main>
  );
}

/** Whether the page runs in the browser: false while it is drawn on the server and hydrated, true from then on. */
const noChanges = () => () => undefined;

/**
 * The app itself, running, where the post's picture would be: anyone can use it right here. The picture shows until
 * it has loaded, and stays when the app doesn't let other sites show it (then its maker is told how to allow it). A
 * post with a clip can switch to it.
 */
function PostApp({ post }: { post: PostView }) {
  const { manages } = useShowcaseViewer();
  const [clip, setClip] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Added once the page runs in the browser, so its load is seen: one that finished before would never say so.
  const mounted = useSyncExternalStore(
    noChanges,
    () => true,
    () => false,
  );
  const live = post.siteFrameable && !clip;
  return (
    <div
      className={classNames(
        'relative w-full md:h-full',
        post.siteFrameable ? 'h-[70dvh] min-h-[420px] md:min-h-0' : 'aspect-[16/10] md:aspect-auto',
      )}
    >
      {live && mounted ? (
        <iframe
          src={post.siteUrl}
          title={`${post.title}, running`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          allow="clipboard-write; fullscreen"
          onLoad={() => setLoaded(true)}
          className="size-full border-0 bg-white"
        />
      ) : null}
      {!live || !loaded ? (
        <div className={classNames('size-full', { 'pointer-events-none absolute inset-0': live })}>
          <PostMedia post={post} variant="page" priority />
        </div>
      ) : null}
      {post.siteFrameable && post.reel ? (
        <button
          type="button"
          onClick={() => setClip((current) => !current)}
          className="absolute bottom-3 right-3 rounded-full bg-black/65 px-3.5 py-1.5 text-sm font-semibold text-white shadow-lg ring-1 ring-white/25 backdrop-blur-sm hover:bg-black/75"
        >
          {clip ? 'Use the app' : 'Watch the clip'}
        </button>
      ) : null}
      {!post.siteFrameable && manages(post.id) ? (
        <p className="absolute inset-x-3 bottom-3 rounded-md bg-black/70 px-3 py-2 text-xs text-white backdrop-blur-sm">
          Your app doesn’t let other sites show it, so people see this picture. Ask @cloudchef to let cloudchef.build
          show it, and the next update puts the working app here.
        </p>
      ) : null}
    </div>
  );
}

function AuthorLine({ post }: { post: PostView }) {
  return (
    <PersonLink
      username={post.author.username}
      className="flex min-w-0 flex-1 items-center gap-2.5 text-content-primary no-underline"
      label={`${post.author.name}’s page`}
    >
      <Avatar name={post.author.name} image={post.author.image} size={34} />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold hover:underline">{post.author.username}</span>
        <span className="block truncate text-xs text-content-secondary">{post.author.name}</span>
      </span>
    </PersonLink>
  );
}

/** The address of a public project whose post isn't shown: hidden by its author, or not published since public. */
export function PostNotShown({ projectName }: { projectName: string }) {
  return (
    <ShowcaseNotice title={`${projectName} isn’t posted right now.`}>
      <p>It’s a public project, but it isn’t on its author’s page. It shows there after its next publish.</p>
      <p>
        <a href="/explore">See what people made</a>
      </p>
    </ShowcaseNotice>
  );
}
