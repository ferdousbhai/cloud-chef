import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { authClient, refreshSession } from '~/lib/auth-client';
import { messageOf, postJson } from '~/lib/json-request';
import { suggestedUsername, usernameProblem } from '~/lib/usernames';

/**
 * Saving the person's username: their page is `/<username>` and their projects' addresses `<username>/<project>`.
 * `initial` is their username, or a suggestion (`suggested`) that can be saved as it is.
 */
export function UsernameForm({
  initial,
  suggested = false,
  onSaved,
}: {
  initial: string;
  suggested?: boolean;
  onSaved?: () => void;
}) {
  const [username, setUsername] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const problem = username ? usernameProblem(username) : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await postJson('/api/profile/username', { username }, z.object({ username: z.string() }));
      await refreshSession();
      setSaved(true);
      onSaved?.();
    } catch (failure) {
      setError(messageOf(failure, 'Your username could not be saved. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-2" onSubmit={(event) => void save(event)}>
      <label className="grid gap-1 text-sm text-content-secondary">
        Username
        <div className="flex min-w-0 items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-bolt-elements-borderColor bg-transparent px-2.5 py-1.5 font-mono text-sm text-content-primary"
            value={username}
            maxLength={39}
            autoFocus={suggested}
            autoComplete="username"
            spellCheck={false}
            onChange={(event) => {
              setUsername(event.target.value.toLowerCase());
              setSaved(false);
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!username || problem !== null || (!suggested && username === initial)}
          >
            Save
          </Button>
        </div>
      </label>
      <p className="text-xs text-content-tertiary">
        Your page is cloudchef.build/{username || 'username'}, and your projects are {username || 'username'}
        /my-project.
      </p>
      {problem || error ? (
        <p className="text-xs text-content-error" role="alert">
          {problem ?? error}
        </p>
      ) : saved ? (
        <p className="text-xs text-content-secondary" role="status">
          Saved.
        </p>
      ) : null}
    </form>
  );
}

/**
 * Asks someone signed in without a username to choose one before anything else, as GitHub does when an account is
 * made; they can change it later in Settings.
 */
export function ChooseUsernamePrompt() {
  const user = authClient.useSession().data?.user ?? null;
  if (!user || user.username !== null) {
    return null;
  }
  // No close button: the session reloads with the saved username, and this goes away.
  return (
    <Modal title="Choose your username" description="It's your name on CloudChef. You can change it later in Settings.">
      <UsernameForm initial={suggestedUsername(user.email || user.name)} suggested />
    </Modal>
  );
}
