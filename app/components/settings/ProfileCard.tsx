import { ExitIcon, PersonIcon } from '@radix-ui/react-icons';
import { authClient, signOutOfCloudChef } from '~/lib/auth-client';
import { Button } from '@ui/Button';
import { toast } from 'sonner';
import { messageOf } from '~/lib/json-request';

export function ProfileCard() {
  const user = authClient.useSession().data?.user ?? null;
  const handleLogout = async () => {
    try {
      await signOutOfCloudChef();
    } catch (error) {
      toast.error(messageOf(error, 'Unable to sign out. Please try again.'));
    }
  };

  if (!user) {
    return null;
  }

  return (
    <section className="app-card w-full p-4" aria-labelledby="profile-heading">
      <div className="flex flex-wrap items-center gap-3">
        <div className="size-12 min-w-12 overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-sm">
          {user.image ? (
            <img src={user.image} alt={user.name || 'User'} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center">
              <PersonIcon className="size-8 text-content-tertiary" aria-hidden />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="profile-heading" className="app-card-title truncate">
            {user.name || 'CloudChef user'}
          </h2>
          {user.email && <p className="mt-1 truncate text-sm text-content-secondary">{user.email}</p>}
        </div>
        <div className="w-full">
          <Button variant="neutral" size="sm" onClick={() => void handleLogout()} icon={<ExitIcon aria-hidden />}>
            Log out
          </Button>
        </div>
      </div>
    </section>
  );
}
