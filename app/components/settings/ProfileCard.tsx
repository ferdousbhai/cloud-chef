import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import { ExitIcon, PersonIcon } from '@radix-ui/react-icons';
import { signOutOfCloudChef } from '~/lib/auth-client';
import { Button } from '@ui/Button';
import { toast } from 'sonner';

export function ProfileCard() {
  const profile = useStore(profileStore);
  const handleLogout = async () => {
    try {
      await signOutOfCloudChef();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to sign out. Please try again.');
    }
  };

  if (!profile) {
    return null;
  }

  return (
    <section className="app-card w-full p-5 sm:p-6" aria-labelledby="profile-heading">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="size-20 min-w-20 overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-sm">
          {profile.avatar ? (
            <img src={profile.avatar} alt={profile?.username || 'User'} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center">
              <PersonIcon className="size-8 text-content-tertiary" aria-hidden />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="app-page-eyebrow">Cloudflare identity</p>
          <h2 id="profile-heading" className="app-card-title mt-2 truncate">
            {profile.username || 'CloudChef user'}
          </h2>
          {profile.email && <p className="mt-1 truncate text-sm text-content-secondary">{profile.email}</p>}
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Button variant="danger" size="sm" onClick={() => void handleLogout()} icon={<ExitIcon aria-hidden />}>
            Log out
          </Button>
        </div>
      </div>
    </section>
  );
}
