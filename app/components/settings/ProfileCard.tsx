import { ExitIcon, PersonIcon } from '@radix-ui/react-icons';
import { authClient } from '~/lib/auth-client';
import { logOut } from '~/lib/account-actions.client';
import { Button } from '@ui/Button';
import { UsernameForm } from './UsernameForm.client';

export function ProfileCard() {
  const user = authClient.useSession().data?.user ?? null;

  if (!user) {
    return null;
  }

  return (
    <section className="app-card w-full p-4 sm:p-5" aria-labelledby="profile-heading">
      <div className="flex min-w-0 items-center gap-3">
        <div className="size-11 min-w-11 overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
          {user.image ? (
            <img src={user.image} alt={user.name || 'User'} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center">
              <PersonIcon className="size-6 text-content-tertiary" aria-hidden />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="profile-heading" className="app-card-title truncate">
            {user.name || 'CloudChef user'}
          </h2>
          {user.email && <p className="truncate text-sm text-content-secondary">{user.email}</p>}
        </div>
        <Button variant="neutral" size="sm" onClick={() => void logOut()} icon={<ExitIcon aria-hidden />}>
          Log out
        </Button>
      </div>
      <div className="mt-4">
        <UsernameForm key={user.username ?? ''} initial={user.username ?? ''} />
      </div>
    </section>
  );
}
