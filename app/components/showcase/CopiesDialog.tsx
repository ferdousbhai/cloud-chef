import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { messageOf } from '~/lib/json-request';
import { loadCopies, startThread, type CopyOfPost } from '~/lib/showcase-api';
import { COMMENT_MAX, type PostThread } from '~/lib/showcase';
import { Avatar } from './Avatar';

/**
 * A post's public copies, each linking to its own post. Someone with a public copy of their own can suggest a change
 * from it: that starts a thread on this post that names the copy, for the people who make this app to try and take.
 */
export function CopiesDialog({
  postId,
  title,
  onSuggested,
  onClose,
}: {
  postId: string;
  title: string;
  onSuggested: (thread: PostThread) => void;
  onClose: () => void;
}) {
  const [copies, setCopies] = useState<CopyOfPost[] | null>(null);
  const [own, setOwn] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadCopies(postId)
      .then((answer) => {
        setCopies(answer.copies);
        setOwn(answer.own);
        setFrom(answer.own[0]?.id ?? '');
      })
      .catch(() => setError('The copies couldn’t be loaded.'));
  }, [postId]);

  const suggest = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const { thread } = await startThread(postId, text.trim(), from);
      onSuggested(thread);
    } catch (cause) {
      setError(messageOf(cause, 'Your suggestion couldn’t be posted. Try again.'));
      setSending(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Copies of ${title}`}>
      <div className="grid gap-4 text-sm">
        {copies === null && !error ? <p role="status">Loading…</p> : null}
        {copies?.length === 0 ? <p className="text-content-secondary">No public copies yet.</p> : null}
        {copies && copies.length > 0 ? (
          <ul className="grid max-h-72 gap-2 overflow-y-auto">
            {copies.map((copy) => (
              <li key={copy.path}>
                <a href={copy.path} className="flex min-w-0 items-center gap-2.5 text-content-primary no-underline">
                  <Avatar name={copy.author.name} image={copy.author.image} size={28} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold hover:underline">{copy.name}</span>
                    <span className="block truncate text-xs text-content-secondary">@{copy.author.username}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {own.length > 0 ? (
          <form
            className="grid gap-2 border-t border-bolt-elements-borderColor pt-4"
            onSubmit={(event) => void suggest(event)}
          >
            <p className="font-semibold text-content-primary">Suggest a change from your copy</p>
            {own.length > 1 ? (
              <select
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                aria-label="Your copy"
                className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2"
              >
                {own.map((copy) => (
                  <option key={copy.id} value={copy.id}>
                    {copy.name}
                  </option>
                ))}
              </select>
            ) : null}
            <textarea
              rows={3}
              maxLength={COMMENT_MAX}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="What did you change, and why might they want it?"
              aria-label="Your suggestion"
              className="w-full resize-y rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-content-primary placeholder:text-content-tertiary focus:border-(--cc-accent) focus:outline-hidden"
            />
            <div className="flex justify-end">
              <Button type="submit" loading={sending} disabled={text.trim() === ''}>
                Suggest
              </Button>
            </div>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="text-content-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
