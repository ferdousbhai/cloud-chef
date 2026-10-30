import { useEffect, useState, type ReactNode } from 'react';
import { loadNotifications, markNotificationsRead } from '~/lib/showcase-api';
import { timeAgo, type NotificationView } from '~/lib/showcase';
import { classNames } from '~/utils/classNames';
import { Avatar } from './Avatar';

/** `/notifications`: who followed, liked, commented on or copied the person's work, and anything taken down. */
export function Notifications() {
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    loadNotifications(controller.signal)
      .then((loaded) => {
        setItems(loaded);
        // Seeing them reads them; the unread ones stay marked on this page until it's left.
        if (loaded.some((item) => item.unread)) {
          void markNotificationsRead().catch(() => undefined);
        }
      })
      .catch(() => !controller.signal.aborted && setError(true));
    return () => controller.abort();
  }, []);
  return (
    <main className="mx-auto grid w-full max-w-xl gap-4 px-3 pb-16 pt-6 sm:px-4 sm:pt-10">
      <h1 className="px-1 text-2xl font-semibold tracking-tight text-content-primary">Notifications</h1>
      {error ? <p className="px-1 text-sm text-content-secondary">Your notifications couldn’t be loaded.</p> : null}
      {items === null && !error ? (
        <p className="px-1 text-sm text-content-tertiary" role="status">
          Loading…
        </p>
      ) : null}
      {items?.length === 0 ? (
        <p className="px-1 py-12 text-center text-sm text-content-secondary">
          Nothing yet. When people follow you, or like, comment on or copy what you made, you’ll see it here.
        </p>
      ) : null}
      {items && items.length > 0 ? (
        <ul className="showcase-card divide-y divide-bolt-elements-borderColor overflow-hidden">
          {items.map((item) => (
            <li
              key={item.id}
              className={classNames('flex items-start gap-3 px-3 py-3', {
                'bg-[color-mix(in_srgb,var(--cc-accent)_7%,transparent)]': item.unread,
              })}
            >
              {item.actor ? (
                <Avatar name={item.actor.name} image={item.actor.image} size={38} />
              ) : (
                <span
                  aria-hidden
                  className="showcase-avatar inline-flex size-[38px] items-center justify-center rounded-full"
                >
                  !
                </span>
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="wrap-anywhere text-content-primary">{describe(item)}</p>
                <p className="mt-0.5 text-xs text-content-tertiary">{timeAgo(item.createdAt)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

function Person({ actor }: { actor: NotificationView['actor'] }) {
  if (!actor) {
    return <>Someone</>;
  }
  return actor.username ? (
    <a href={`/${actor.username}`} className="font-semibold text-content-primary no-underline hover:underline">
      {actor.name}
    </a>
  ) : (
    <span className="font-semibold">{actor.name}</span>
  );
}

function Project({ item }: { item: NotificationView }) {
  const name = item.projectName ?? 'your project';
  return item.postPath ? (
    <a href={item.postPath} className="font-semibold text-content-primary no-underline hover:underline">
      {name}
    </a>
  ) : (
    <span className="font-semibold">{name}</span>
  );
}

/** "Sara started following you.", in everyday words. */
function describe(item: NotificationView): ReactNode {
  switch (item.kind) {
    case 'new_follower':
      return (
        <>
          <Person actor={item.actor} /> started following you.
        </>
      );
    case 'project_copied':
      return (
        <>
          <Person actor={item.actor} /> made a copy of <Project item={item} />.
        </>
      );
    case 'post_liked':
      return (
        <>
          <Person actor={item.actor} />
          {item.others > 0 ? ` and ${item.others} ${item.others === 1 ? 'other' : 'others'}` : ''} liked{' '}
          <Project item={item} />.
        </>
      );
    case 'post_commented':
      return (
        <>
          <Person actor={item.actor} /> commented on <Project item={item} />
          {item.detail ? <span className="text-content-secondary">: “{item.detail}”</span> : '.'}
        </>
      );
    case 'post_removed':
      return (
        <>
          <Project item={item} /> was taken off your page because it was reported as{' '}
          {item.detail ?? 'breaking the rules'}. The project itself is unchanged. If you think that’s wrong, tell us
          through <a href="/support">Support</a>.
        </>
      );
    case 'comment_removed':
      return (
        <>
          Your comment on <Project item={item} /> was taken down because it was reported as{' '}
          {item.detail ?? 'breaking the rules'}.
        </>
      );
  }
}
