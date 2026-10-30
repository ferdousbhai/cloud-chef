import { useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { messageOf } from '~/lib/json-request';
import { deletePost, reportPost, setCaption } from '~/lib/showcase-api';
import { CAPTION_MAX, REPORT_REASON_LABELS, REPORT_REASONS, type ReportReason } from '~/lib/showcase';

const TEXTAREA_CLASS =
  'w-full resize-y rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-sm text-content-primary placeholder:text-content-tertiary focus:border-(--cc-accent) focus:outline-hidden';

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-content-error wrap-anywhere">
      {error}
    </p>
  ) : null;
}

/** "Edit caption": the words under a post's picture. */
export function CaptionDialog({
  postId,
  caption,
  onSaved,
  onClose,
}: {
  postId: string;
  caption: string | null;
  onSaved: (caption: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(caption ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await setCaption(postId, text));
    } catch (cause) {
      setError(messageOf(cause, 'The caption could not be saved. Try again.'));
      setSaving(false);
    }
  };
  return (
    <Modal onClose={onClose} title="Edit caption">
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <label className="grid gap-1.5 text-sm">
          <span className="text-content-secondary">What is it, and what’s worth trying?</span>
          <textarea
            className={TEXTAREA_CLASS}
            rows={5}
            maxLength={CAPTION_MAX}
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoFocus
          />
        </label>
        <p className="text-right text-xs tabular-nums text-content-tertiary">
          {text.length} / {CAPTION_MAX}
        </p>
        <ErrorLine error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "Report": what's wrong with a post or one of its comments, for CloudChef's operators. Anyone may report. */
export function ReportDialog({
  postId,
  commentId = null,
  onClose,
}: {
  postId: string;
  commentId?: string | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = commentId ? 'comment' : 'post';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await reportPost({ postId, commentId, reason, note });
      setSent(true);
    } catch (cause) {
      setError(messageOf(cause, 'The report could not be sent. Try again.'));
    } finally {
      setSending(false);
    }
  };
  if (sent) {
    return (
      <Modal onClose={onClose} title="Thanks for telling us">
        <p className="text-sm text-content-secondary">
          CloudChef looks at every report. If this {what} breaks the rules, it comes down and the person who posted it
          is told.
        </p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose} title={`Report this ${what}`}>
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <fieldset className="grid gap-1">
          <legend className="mb-1.5 text-sm text-content-secondary">What’s wrong with it?</legend>
          {REPORT_REASONS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm text-content-primary hover:bg-bolt-elements-background-depth-2"
            >
              <input
                type="radio"
                name="reason"
                value={option}
                checked={reason === option}
                onChange={() => setReason(option)}
                className="accent-(--cc-accent)"
              />
              {REPORT_REASON_LABELS[option]}
            </label>
          ))}
        </fieldset>
        <label className="grid gap-1.5 text-sm">
          <span className="text-content-secondary">Anything else we should know? (optional)</span>
          <textarea
            className={TEXTAREA_CLASS}
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <ErrorLine error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={sending} disabled={!reason}>
            Report
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "Delete post": the post, its likes, comments, pictures and video go; the project stays as it is. */
export function DeletePostDialog({
  postId,
  title,
  onDeleted,
  onClose,
}: {
  postId: string;
  title: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deletePost(postId);
      onDeleted();
    } catch (cause) {
      setError(messageOf(cause, 'The post could not be deleted. Try again.'));
      setDeleting(false);
    }
  };
  return (
    <Modal onClose={onClose} title={`Delete the post of ${title}?`}>
      <div className="grid gap-2 text-sm text-content-secondary">
        <p>Its likes, comments, picture and video go with it. The project itself stays as it is.</p>
        <p>
          While the project is public, its next publish puts a new post on your page. To stop it showing for good, make
          the project private, or choose Hide from my page instead.
        </p>
      </div>
      <ErrorLine error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" loading={deleting} onClick={() => void remove()}>
          Delete post
        </Button>
      </div>
    </Modal>
  );
}
