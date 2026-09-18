import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CloudChefAuthProvider } from './chat/CloudChefAuthWrapper';
import { HomeIntro } from './chat/HomeIntro.client';
import { Toaster } from '~/components/ui/Toaster';
import { UserProvider } from '~/components/UserProvider';
import { captureProductEvent } from '~/lib/telemetry.client';

const HomepageChat = lazy(() => import('./HomepageChat.client').then((module) => ({ default: module.HomepageChat })));

export function Homepage({ initialId }: { initialId: string }) {
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const initialPromptRef = useRef<string | null>(null);
  useEffect(() => {
    void captureProductEvent('landing_viewed');
  }, []);
  const startChat = useCallback(async (prompt: string) => {
    if (initialPromptRef.current !== null) {
      return false;
    }
    initialPromptRef.current = prompt;
    setInitialPrompt(prompt);
    return true;
  }, []);

  const homeIntro = (
    <HomeIntro
      disabledReason={null}
      isStreaming={false}
      messagesLength={0}
      onSend={startChat}
      onStop={() => undefined}
      sendMessageInProgress={initialPrompt !== null}
    />
  );

  return (
    <>
      <CloudChefAuthProvider>
        <UserProvider>
          {initialPrompt === null ? (
            homeIntro
          ) : (
            <Suspense fallback={homeIntro}>
              <HomepageChat initialId={initialId} initialPrompt={initialPrompt} />
            </Suspense>
          )}
        </UserProvider>
      </CloudChefAuthProvider>
      <Toaster />
    </>
  );
}
