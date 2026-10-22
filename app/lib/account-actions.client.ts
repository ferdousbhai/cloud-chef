import { toast } from 'sonner';
import { signOutOfCloudChef, switchWorkspace } from '~/lib/auth-client';
import { messageOf } from '~/lib/json-request';

/** A Log out button: signs out, or says in a toast why it could not. */
export async function logOut(): Promise<void> {
  try {
    await signOutOfCloudChef();
  } catch (error) {
    toast.error(messageOf(error, 'Unable to sign out. Please try again.'));
  }
}

/**
 * Opens another account to build in, or says in a toast why it could not. Resolves true when it could
 * not, since the page stays; otherwise the page leaves, or the person stayed for edits not yet saved.
 */
export async function switchAccount(connectionId: string): Promise<boolean> {
  try {
    await switchWorkspace(connectionId);
    return false;
  } catch (error) {
    toast.error(messageOf(error, 'Unable to switch accounts.'));
    return true;
  }
}
