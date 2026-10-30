import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { EyeOpenIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { messageOf } from '~/lib/json-request';
import { loadHiddenPosts, loadPersonPage, setBio, setFollowing, setPostShown } from '~/lib/showcase-api';
import { BIO_MAX, countLabel, type PostView, type PublicPerson, type ShowcaseCursor } from '~/lib/showcase';
import { Avatar } from './Avatar';
import { FollowListDialog } from './FollowListDialog';
import { PostGrid } from './PostGrid';
import { PostMedia } from './PostMedia';
import { ShowcaseViewerProvider, useShowcaseViewer } from './ViewerContext';

/**
 * A person's page, `/<username>`: their picture, name, line about themselves and counts, a Follow button, and a grid
 * of what they made, newest first. On their own page they can change their line, see who follows them, and show
 * again the posts they hid.
 */
export function PersonPage({
  person,
  posts,
  next,
}: {
  person: PublicPerson;
  posts: PostView[];
  next: ShowcaseCursor | null;
}) {
  return (
    <ShowcaseViewerProvider postIds={[]} person={person.username}>
      <PersonPageContent person={person} posts={posts} next={next} />
    </ShowcaseViewerProvider>
  );
}

function PersonPageContent({
  person: initialPerson,
  posts: firstPosts,
  next: firstNext,
}: {
  person: PublicPerson;
  posts: PostView[];
  next: ShowcaseCursor | null;
}) {
  const { viewer } = useShowcaseViewer();
  const [person, setPerson] = useState(initialPerson);
  const [posts, setPosts] = useState(firstPosts);
  const [next, setNext] = useState(firstNext);
  const [loadingMore, setLoadingMore] = useState(false);
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  const own = viewer?.signedIn === true && viewer.me.username === person.username;

  const more = () => {
    setLoadingMore(true);
    loadPersonPage(person.username, next)
      .then((page) => {
        setPosts((current) => [...current, ...page.posts]);
        setNext(page.next);
      })
      .catch(() => toast.error('More posts couldn’t be loaded. Try again.'))
      .finally(() => setLoadingMore(false));
  };

  const counts = (
    <ul className="flex gap-6 text-sm text-content-secondary sm:gap-8">
      <li>
        <span className="font-semibold text-content-primary tabular-nums">{person.posts}</span>{' '}
        {person.posts === 1 ? 'post' : 'posts'}
      </li>
      <li>
        <CountButton own={own} onClick={() => setList('followers')}>
          <span className="font-semibold text-content-primary tabular-nums">{person.followers}</span>{' '}
          {person.followers === 1 ? 'follower' : 'followers'}
        </CountButton>
      </li>
      <li>
        <CountButton own={own} onClick={() => setList('following')}>
          <span className="font-semibold text-content-primary tabular-nums">{person.following}</span> following
        </CountButton>
      </li>
    </ul>
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6 sm:px-6 sm:pt-12">
      <header className="flex items-center gap-5 sm:gap-12 sm:px-6">
        <span className="sm:hidden">
          <Avatar name={person.name} image={person.image} size={80} />
        </span>
        <span className="hidden sm:block">
          <Avatar name={person.name} image={person.image} size={144} />
        </span>
        <div className="grid min-w-0 flex-1 gap-3 sm:gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="truncate text-xl font-normal text-content-primary sm:text-2xl">{person.username}</h1>
            {own ? (
              <EditPageButton bio={person.bio} onSaved={(bio) => setPerson({ ...person, bio })} />
            ) : (
              <FollowButton person={person} onCount={(followers) => setPerson({ ...person, followers })} />
            )}
          </div>
          <div className="hidden sm:block">{counts}</div>
          <div className="hidden min-w-0 sm:block">
            <PersonLines person={person} />
          </div>
        </div>
      </header>
      <div className="mt-4 grid gap-4 sm:hidden">
        <PersonLines person={person} />
        <div className="border-t border-bolt-elements-borderColor pt-3">{counts}</div>
      </div>
      <div className="mt-6 border-t border-bolt-elements-borderColor pt-6 sm:mt-10">
        {posts.length === 0 ? (
          <div className="grid justify-items-center gap-2 py-16 text-center">
            <p className="text-lg font-semibold text-content-primary">No posts yet</p>
            <p className="max-w-sm text-sm text-content-secondary">
              {own
                ? 'Make a project public and publish it: it shows up here, for anyone to see and try.'
                : `When ${person.name} publishes a public project, it shows up here.`}
            </p>
          </div>
        ) : (
          <PostGrid posts={posts} />
        )}
        {next ? (
          <div className="mt-6 flex justify-center">
            <Button variant="neutral" loading={loadingMore} onClick={more}>
              More posts
            </Button>
          </div>
        ) : null}
      </div>
      {own ? <HiddenPosts /> : null}
      {list ? <FollowListDialog which={list} onClose={() => setList(null)} /> : null}
    </main>
  );
}

function PersonLines({ person }: { person: PublicPerson }) {
  return (
    <div className="grid gap-0.5 text-sm">
      <p className="font-semibold text-content-primary">{person.name}</p>
      {person.bio ? <p className="wrap-anywhere whitespace-pre-line text-content-primary">{person.bio}</p> : null}
    </div>
  );
}

/** Follower lists are the person's own: their counts open them; anyone else's are plain numbers. */
function CountButton({ own, onClick, children }: { own: boolean; onClick: () => void; children: React.ReactNode }) {
  return own ? (
    <button type="button" className="text-content-secondary hover:underline" onClick={onClick}>
      {children}
    </button>
  ) : (
    <>{children}</>
  );
}

function FollowButton({ person, onCount }: { person: PublicPerson; onCount: (followers: number) => void }) {
  const { viewer, signedIn } = useShowcaseViewer();
  // What the viewer said, until a follow here changes it.
  const [following, setFollowingState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const isFollowing = following ?? (viewer?.signedIn === true && viewer.following === true);
  const toggle = () =>
    signedIn(`Sign in to follow ${person.name}.`, () => {
      setBusy(true);
      setFollowing(person.username, !isFollowing)
        .then((answer) => {
          setFollowingState(answer.following);
          onCount(answer.followers);
        })
        .catch((error) => toast.error(messageOf(error, 'That didn’t go through. Try again.')))
        .finally(() => setBusy(false));
    });
  return (
    <Button
      size="sm"
      variant={isFollowing ? 'neutral' : 'primary'}
      loading={busy}
      onClick={toggle}
      className="min-w-24"
    >
      {isFollowing ? 'Following' : 'Follow'}
    </Button>
  );
}

function EditPageButton({ bio, onSaved }: { bio: string | null; onSaved: (bio: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(bio ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await setBio(text));
      setOpen(false);
    } catch (cause) {
      setError(messageOf(cause, 'That couldn’t be saved. Try again.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="neutral" onClick={() => setOpen(true)}>
        Edit page
      </Button>
      {open ? (
        <Modal onClose={() => setOpen(false)} title="Edit your page">
          <form className="grid gap-3 text-sm" onSubmit={(event) => void submit(event)}>
            <label className="grid gap-1.5">
              <span className="text-content-secondary">A line about you, under your name</span>
              <textarea
                rows={3}
                maxLength={BIO_MAX}
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="w-full resize-y rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-content-primary focus:border-(--cc-accent) focus:outline-hidden"
                autoFocus
              />
            </label>
            <p className="text-right text-xs tabular-nums text-content-tertiary">
              {text.length} / {BIO_MAX}
            </p>
            <p className="text-xs text-content-tertiary">
              Your name and picture come from your sign-in; your username is in Settings.
            </p>
            {error ? (
              <p role="alert" className="text-content-error">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="neutral" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

/** On a person's own page: the posts they hid, or that are hidden for another reason, and why. */
export function HiddenPosts() {
  const [posts, setPosts] = useState<Awaited<ReturnType<typeof loadHiddenPosts>>>([]);
  useEffect(() => {
    const controller = new AbortController();
    loadHiddenPosts(controller.signal)
      .then(setPosts)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (posts.length === 0) {
    return null;
  }
  const show = (post: (typeof posts)[number]) =>
    setPostShown(post.id, true)
      .then(() => {
        toast.success(`${post.title} is on your page again.`);
        window.location.reload();
      })
      .catch((error) => toast.error(messageOf(error, 'It couldn’t be shown. Try again.')));
  return (
    <section className="mt-12 grid gap-3" aria-labelledby="hidden-posts">
      <h2 id="hidden-posts" className="text-sm font-semibold text-content-secondary">
        Hidden from your page · only you see these
      </h2>
      <ul className="grid gap-2">
        {posts.map((post) => (
          <li key={post.id} className="showcase-card flex items-center gap-3 p-2.5">
            <div className="aspect-[4/3] w-20 shrink-0 overflow-hidden rounded-md">
              {/* A hidden post's pictures aren't served to anyone, so its name stands in for them. */}
              <PostMedia post={{ ...post, screenshot: null, video: null }} variant="tile" />
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium text-content-primary">{post.title}</p>
              <p className="text-xs text-content-tertiary">
                {post.hiddenReason === 'reported'
                  ? 'Held after reports, until CloudChef has looked at it.'
                  : post.hiddenReason === 'project_private' || !post.projectPublic
                    ? 'The project is private.'
                    : `You hid it. ${countLabel(post.likeCount, 'like')}.`}
              </p>
            </div>
            {post.hiddenReason === 'author' || (post.hiddenReason === 'project_private' && post.projectPublic) ? (
              <Button size="sm" variant="neutral" icon={<EyeOpenIcon />} onClick={() => void show(post)}>
                Show on my page
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
