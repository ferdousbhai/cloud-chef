import { createContext, useContext, useEffect, useLayoutEffect } from 'react';
import { authClient } from '~/lib/auth-client';
import { userIdStore, useUserIdOrNullOrLoading } from '~/lib/stores/userId';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type CloudChefAuthState = { kind: 'loading' } | { kind: 'unauthenticated' } | { kind: 'fullyLoggedIn'; userId: string };

const CloudChefAuthContext = createContext<{ state: CloudChefAuthState } | null>(null);

export function useCloudChefAuth() {
  const context = useContext(CloudChefAuthContext);
  if (context === null) {
    throw new Error('useCloudChefAuth must be used within a CloudChefAuthProvider');
  }
  return context.state;
}

export function CloudChefAuthProvider({ children }: { children: React.ReactNode }) {
  const storedUserId = useUserIdOrNullOrLoading();
  const { data: authSession, isPending } = authClient.useSession();
  const userId = authSession?.user.id ?? null;

  useIsomorphicLayoutEffect(() => {
    userIdStore.set(isPending ? undefined : userId);
  }, [isPending, userId]);

  const state: CloudChefAuthState =
    isPending || storedUserId === undefined
      ? { kind: 'loading' }
      : userId
        ? { kind: 'fullyLoggedIn', userId }
        : { kind: 'unauthenticated' };

  return <CloudChefAuthContext.Provider value={{ state }}>{children}</CloudChefAuthContext.Provider>;
}
