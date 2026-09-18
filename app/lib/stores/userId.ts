import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { waitForStoreValue } from './waitForStore';

const logger = createScopedLogger('UserIdStore');

type CloudChefUserId = string;

export function useUserIdOrNullOrLoading(): CloudChefUserId | null | undefined {
  return useStore(userIdStore);
}

export async function waitForUserId(caller?: string): Promise<CloudChefUserId> {
  const currentUserId = userIdStore.get();
  if (currentUserId !== null && currentUserId !== undefined) {
    return currentUserId;
  }

  if (caller) {
    logger.debug(`[${caller}] Waiting for user ID...`);
  }

  return waitForStoreValue(userIdStore, (userId) => userId);
}

export const userIdStore = atom<CloudChefUserId | null | undefined>(undefined);

export function isAuthenticated(): boolean {
  const userId = userIdStore.get();
  return userId !== null && userId !== undefined;
}
