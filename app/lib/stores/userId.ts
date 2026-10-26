import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';

type CloudChefUserId = string;

export function useUserIdOrNullOrLoading(): CloudChefUserId | null | undefined {
  return useStore(userIdStore);
}

/** Whether this session builds in a Cloudflare account; loading until the session is known. */
export function useCloudChefAuthKind(): 'loading' | 'unauthenticated' | 'fullyLoggedIn' {
  const userId = useStore(userIdStore);
  return userId === undefined ? 'loading' : userId === null ? 'unauthenticated' : 'fullyLoggedIn';
}

export const userIdStore = atom<CloudChefUserId | null | undefined>(undefined);
