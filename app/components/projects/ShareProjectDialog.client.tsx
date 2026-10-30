import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@ui/Modal';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { Avatar } from '~/components/showcase/Avatar';
import { messageOf } from '~/lib/json-request';
import type { ProjectRole } from '~/lib/cloudflare/org-projects.client';
import {
  loadSharing,
  resendInvitation,
  roleSentence,
  setInvitationRole,
  setPersonRole,
  shareProjectWith,
  type ProjectSharing,
} from '~/lib/cloudflare/project-sharing.client';
import { FeedbackLine, errorFeedback, noteFeedback, type Feedback } from '~/components/settings/Feedback';

const ROLES: { value: ProjectRole; label: string }[] = [
  { value: 'edit', label: 'Can edit' },
  { value: 'view', label: 'Can view' },
];

const SELECT_CLASS =
  'min-h-8 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 text-xs text-content-primary';

/**
 * Who may use a project, and adding someone, as a document is shared: their username or email, and Can view or Can
 * edit. An address always shows as Invited until someone takes it, so it never says whether it has an account.
 * Reached from a project's menu by whoever runs it (its owner, or one of its team's admins).
 */
export function ShareProjectDialog({
  project,
  onClose,
}: {
  project: { id: string; name: string };
  onClose: () => void;
}) {
  const [sharing, setSharing] = useState<ProjectSharing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [to, setTo] = useState('');
  const [role, setRole] = useState<ProjectRole>('edit');
  // What is being saved: the form, or one row's change.
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      loadSharing(project.id).then(
        (loaded) => {
          setLoadError(null);
          setSharing(loaded);
        },
        (error) => setLoadError(messageOf(error, 'Sharing could not be loaded. Try again.')),
      ),
    [project.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, change: () => Promise<ProjectSharing>, done?: (next: ProjectSharing) => void) => {
    setBusy(key);
    setFeedback(null);
    try {
      const next = await change();
      setSharing(next);
      done?.(next);
    } catch (error) {
      setFeedback(errorFeedback(messageOf(error, 'That could not be saved. Try again.')));
    } finally {
      setBusy(null);
    }
  };

  const share = (event: FormEvent) => {
    event.preventDefault();
    const named = to.trim();
    if (!named) {
      return;
    }
    void run(
      'form',
      () => shareProjectWith(project.id, named, role),
      (next) => {
        setTo('');
        const done = next.done;
        setFeedback(
          done && 'invited' in done
            ? noteFeedback(`Invited ${done.invited}. They’ll get an email with a link.`)
            : noteFeedback(roleSentence(done?.shared ?? 'They', role)),
        );
      },
    );
  };

  return (
    <Modal onClose={onClose} title={`Share ${project.name}`}>
      <form onSubmit={share} className="grid gap-2">
        <label htmlFor="share-to" className="sr-only">
          Email or username
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            id="share-to"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Email or username"
            className="min-w-0 flex-1 basis-48"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          <select
            aria-label="What they may do"
            value={role}
            onChange={(event) => setRole(event.target.value === 'view' ? 'view' : 'edit')}
            className={`${SELECT_CLASS} min-h-9 text-sm`}
          >
            {ROLES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <Button type="submit" size="md" disabled={!to.trim() || busy !== null} loading={busy === 'form'}>
            Share
          </Button>
        </div>
        <p className="text-xs text-content-tertiary">
          {role === 'edit'
            ? `They can change it and put changes live on ${sharing?.team ? 'its' : 'your'} site.`
            : 'They can look through it, its history and its code, and download it.'}
        </p>
      </form>
      <FeedbackLine feedback={feedback} />

      <div className="mt-5 grid gap-2">
        <h3 className="text-xs font-medium text-content-secondary">People with access</h3>
        {loadError !== null ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
            <span>{loadError}</span>
            <Button size="xs" variant="neutral" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : sharing === null ? (
          <p className="text-sm text-content-tertiary" role="status">
            Loading…
          </p>
        ) : (
          <ul className="grid gap-1" aria-label={`Who can use ${project.name}`}>
            {sharing.people.map((person) => (
              <li key={person.userId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1">
                <Avatar name={person.name} image={person.image} size={28} />
                <span className="min-w-0 flex-1 basis-36">
                  <span className="block truncate text-sm text-content-primary">{person.name}</span>
                  {person.username ? (
                    <span className="block truncate text-xs text-content-tertiary">{person.username}</span>
                  ) : null}
                </span>
                {person.role === 'owner' ? (
                  <span className="text-xs text-content-secondary">{sharing.team ? 'Admin' : 'Owner'}</span>
                ) : (
                  <span className="flex items-center gap-1">
                    <select
                      aria-label={`What ${person.name} may do`}
                      value={person.role}
                      disabled={busy !== null}
                      onChange={(event) => {
                        const next: ProjectRole = event.target.value === 'view' ? 'view' : 'edit';
                        void run(person.userId, () => setPersonRole(project.id, person.userId, next));
                      }}
                      className={SELECT_CLASS}
                    >
                      {ROLES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="xs"
                      variant="subtle"
                      aria-label={`Remove ${person.name}`}
                      disabled={busy !== null}
                      loading={busy === `remove:${person.userId}`}
                      onClick={() =>
                        void run(
                          `remove:${person.userId}`,
                          () => setPersonRole(project.id, person.userId, null),
                          () => setFeedback(noteFeedback(`${person.name} no longer has access.`)),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </span>
                )}
              </li>
            ))}
            {sharing.invitations.map((invitation) => (
              <li key={invitation.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1">
                <Avatar name={invitation.email} image={null} size={28} />
                <span className="min-w-0 flex-1 basis-36">
                  <span className="block truncate text-sm text-content-primary" title={invitation.email}>
                    {invitation.email}
                  </span>
                  <span className="block text-xs text-content-tertiary">Invited</span>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  <select
                    aria-label={`What ${invitation.email} may do`}
                    value={invitation.role}
                    disabled={busy !== null}
                    onChange={(event) => {
                      const next: ProjectRole = event.target.value === 'view' ? 'view' : 'edit';
                      void run(invitation.id, () => setInvitationRole(project.id, invitation.id, next));
                    }}
                    className={SELECT_CLASS}
                  >
                    {ROLES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="xs"
                    variant="subtle"
                    disabled={busy !== null}
                    loading={busy === `resend:${invitation.id}`}
                    onClick={() =>
                      void run(
                        `resend:${invitation.id}`,
                        () => resendInvitation(project.id, invitation.id),
                        () => setFeedback(noteFeedback(`Sent again to ${invitation.email}.`)),
                      )
                    }
                  >
                    Resend
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    aria-label={`Cancel the invitation to ${invitation.email}`}
                    disabled={busy !== null}
                    loading={busy === `cancel:${invitation.id}`}
                    onClick={() =>
                      void run(`cancel:${invitation.id}`, () => setInvitationRole(project.id, invitation.id, null))
                    }
                  >
                    Cancel
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-content-tertiary">
        {sharing?.team
          ? 'People outside the team work on it from their own Cloudflare account. The site stays in the team’s.'
          : 'People you share with work on it from their own Cloudflare account. The site stays in yours.'}
      </p>
    </Modal>
  );
}
