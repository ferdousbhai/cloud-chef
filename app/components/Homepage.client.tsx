import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { HomeIntro } from './chat/HomeIntro.client';
import { Toaster } from '~/components/ui/Toaster';
import { captureProductEvent } from '~/lib/telemetry.client';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';

const ProjectsHome = lazy(() =>
  import('./projects/ProjectsHome.client').then((module) => ({ default: module.ProjectsHome })),
);
const HomepageChat = lazy(() => import('./HomepageChat.client').then((module) => ({ default: module.HomepageChat })));

export function Homepage({ initialId }: { initialId: string }) {
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  // Signed in, the home lists the person's projects below the prompt; signed out, it's the prompt alone.
  const userId = useUserIdOrNullOrLoading();
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
      homepage
      disabledReason={null}
      isStreaming={false}
      onSend={startChat}
      onStop={() => undefined}
      sendMessageInProgress={initialPrompt !== null}
    >
      {userId ? (
        <Suspense fallback={null}>
          <ProjectsHome />
        </Suspense>
      ) : null}
    </HomeIntro>
  );

  return (
    <>
      {initialPrompt === null ? (
        homeIntro
      ) : (
        <Suspense fallback={homeIntro}>
          <HomepageChat initialId={initialId} initialPrompt={initialPrompt} />
        </Suspense>
      )}
      <Toaster />
    </>
  );
}
