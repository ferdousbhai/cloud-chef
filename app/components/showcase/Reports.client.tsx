import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { getJson, messageOf, postJson } from '~/lib/json-request';
import { REPORT_REASON_LABELS, REPORT_REASONS, timeAgo } from '~/lib/showcase';

const itemSchema = z.object({
  postId: z.string(),
  commentId: z.string().nullable(),
  reports: z.array(
    z.object({
      id: z.string(),
      reason: z.enum(REPORT_REASONS),
      note: z.string().nullable(),
      automatic: z.boolean(),
      createdAt: z.number(),
    }),
  ),
  post: z.object({
    title: z.string(),
    path: z.string().nullable(),
    siteUrl: z.string(),
    status: z.string(),
    hiddenReason: z.string().nullable(),
    caption: z.string().nullable(),
    screenshotUrl: z.string().nullable(),
    author: z.object({
      id: z.string(),
      username: z.string().nullable(),
      name: z.string(),
      email: z.string(),
      paused: z.boolean(),
    }),
  }),
  comment: z
    .object({
      body: z.string(),
      status: z.string(),
      author: z.object({ username: z.string().nullable(), name: z.string() }),
    })
    .nullable(),
});
type ReportedItem = z.infer<typeof itemSchema>;

/**
 * `/reports`, for CloudChef's operators only: every post and comment with open reports, the most reported first,
 * with what was said and the post's picture and site. Dismiss shows again anything reports held; Remove takes it
 * down and tells its author; Pause hides the author's whole page.
 */
export function Reports() {
  const [items, setItems] = useState<ReportedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getJson('/api/showcase/reports', z.object({ items: z.array(itemSchema) }), undefined, controller.signal)
      .then((answer) => setItems(answer.items))
      .catch((cause) => !controller.signal.aborted && setError(messageOf(cause, 'Reports couldn’t be loaded.')));
    return () => controller.abort();
  }, [attempt]);

  const decide = (item: ReportedItem, decision: 'dismiss' | 'remove' | 'pause_author') => {
    const key = `${item.postId}:${item.commentId ?? ''}`;
    setBusy(key);
    postJson('/api/showcase/reports/decide', { postId: item.postId, commentId: item.commentId, decision }, z.unknown())
      .then(() => {
        toast.success(decision === 'dismiss' ? 'Dismissed.' : decision === 'remove' ? 'Taken down.' : 'Page paused.');
        setAttempt((count) => count + 1);
      })
      .catch((cause) => toast.error(messageOf(cause, 'That didn’t go through.')))
      .finally(() => setBusy(null));
  };

  return (
    <main className="mx-auto grid w-full max-w-4xl gap-4 px-4 pb-16 pt-6 sm:pt-10">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-content-primary">Reports</h1>
        <p className="text-sm text-content-secondary">
          Posts and comments people reported. Three people, or CloudChef’s site check, hold one until you decide.
        </p>
      </div>
      {error ? <p className="text-sm text-content-error">{error}</p> : null}
      {items === null && !error ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading…
        </p>
      ) : null}
      {items?.length === 0 ? (
        <p className="py-12 text-center text-sm text-content-secondary">Nothing to look at.</p>
      ) : null}
      <ul className="grid gap-3">
        {items?.map((item) => {
          const key = `${item.postId}:${item.commentId ?? ''}`;
          return (
            <li key={key} className="showcase-card grid gap-3 p-3 sm:grid-cols-[200px_minmax(0,1fr)]">
              <div className="aspect-[16/10] overflow-hidden rounded-md bg-bolt-elements-background-depth-3">
                {item.post.screenshotUrl ? (
                  <img src={item.post.screenshotUrl} alt="" className="size-full object-cover object-top" />
                ) : null}
              </div>
              <div className="grid min-w-0 content-start gap-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-content-primary">
                    {item.comment ? 'A comment on ' : ''}
                    {item.post.path ? <a href={item.post.path}>{item.post.title}</a> : item.post.title}
                  </span>
                  <span className="text-xs text-content-tertiary">
                    by {item.post.author.name} ({item.post.author.username ?? 'no username'}, {item.post.author.email})
                    {item.post.author.paused ? ' · page paused' : ''}
                  </span>
                </div>
                <p className="text-xs text-content-secondary">
                  {item.post.status === 'hidden' && item.post.hiddenReason === 'reported' ? 'Held now. ' : ''}
                  {item.comment?.status === 'held' ? 'Comment held now. ' : ''}
                  Site:{' '}
                  <a href={item.post.siteUrl} target="_blank" rel="noopener noreferrer nofollow">
                    {item.post.siteUrl}
                  </a>
                </p>
                {item.comment ? (
                  <blockquote className="border-l-2 border-bolt-elements-borderColor pl-2 text-content-primary wrap-anywhere">
                    {item.comment.author.name}: {item.comment.body}
                  </blockquote>
                ) : item.post.caption ? (
                  <blockquote className="border-l-2 border-bolt-elements-borderColor pl-2 text-content-secondary wrap-anywhere">
                    {item.post.caption}
                  </blockquote>
                ) : null}
                <ul className="grid gap-1 text-xs text-content-secondary">
                  {item.reports.map((report) => (
                    <li key={report.id}>
                      <span className="font-medium text-content-primary">{REPORT_REASON_LABELS[report.reason]}</span>
                      {report.automatic ? ' · site check' : ''} · {timeAgo(report.createdAt)}
                      {report.note ? <span className="wrap-anywhere">: {report.note}</span> : null}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="neutral" disabled={busy === key} onClick={() => decide(item, 'dismiss')}>
                    Dismiss
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy === key} onClick={() => decide(item, 'remove')}>
                    {item.comment ? 'Remove comment' : 'Remove post'}
                  </Button>
                  {item.post.author.paused ? null : (
                    <Button
                      size="sm"
                      variant="neutral"
                      disabled={busy === key}
                      onClick={() => decide(item, 'pause_author')}
                    >
                      Pause their page
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
