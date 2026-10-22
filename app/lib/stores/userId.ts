import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';

type CloudChefUserId = string;

export function useUserIdOrNullOrLoading(): CloudChefUserId | null | undefined {
  return useStore(userIdStore);
}

export const userIdStore = atom<CloudChefUserId | null | undefined>(undefined);

export function isAuthenticated(): boolean {
  const userId = userIdStore.get();
  return userId !== null && userId !== undefined;
}
