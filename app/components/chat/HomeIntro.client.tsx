import { lazy, Suspense, type ReactNode } from 'react';
import { HomeHeroCopy } from '~/components/HomeHeroCopy';
import { authClient } from '~/lib/auth-client';
import { MessageInput } from './MessageInput';

const DisabledChatMessageSheet = lazy(() =>
  import('./DisabledChatMessageSheet').then((module) => ({ default: module.DisabledChatMessageSheet })),
);

interface HomeIntroProps {
  disabledReason: ReactNode | null;
  isStreaming: boolean;
  onSend: (messageInput: string, onAccepted?: () => void) => Promise<boolean>;
  onStop: () => void;
  sendMessageInProgress: boolean;
  /** The home page, where a new app starts; not a project's own empty chat. */
  homepage?: boolean;
  /** What the signed-in home shows below the prompt: the person's projects. */
  children?: ReactNode;
}

export function HomeIntro({
  disabledReason,
  isStreaming,
  onSend,
  onStop,
  sendMessageInProgress,
  homepage = false,
  children,
}: HomeIntroProps) {
  const { data: session, isPending } = authClient.useSession();
  // Someone added to projects in another person's account starts no new app there.
  const projectsOnly = homepage && session?.context ? !session.context.draftsAllowed : false;
  return (
    <div className="cloudchef-home-shell grow p-4 sm:px-6 lg:px-8">
      <section className="cloudchef-home-copy min-w-0" aria-labelledby="intro">
        <div className="cloudchef-home-hero">
          <div className="min-w-0">
            <HomeHeroCopy headingId="intro" pitch={homepage && !isPending && !session} />

            {projectsOnly ? (
              <div className="cloudchef-home-composer-stack" role="status">
                <p className="app-page-lede mx-auto wrap-break-word text-center">
                  You work on the projects shared with you here. Choose one below to start.
                </p>
              </div>
            ) : (
              <div className="cloudchef-home-composer-stack">
                <MessageInput
                  chatStarted={false}
                  isStreaming={isStreaming}
                  sendMessageInProgress={sendMessageInProgress}
                  disabled={disabledReason !== null}
                  onStop={onStop}
                  onSend={onSend}
                  hasMessages={false}
                />
                {/* The home page never closes its composer, so it loads no sheet; elsewhere the sheet's live
                    region stays mounted, so a reason that appears is announced. */}
                {homepage ? null : (
                  <Suspense fallback={null}>
                    <DisabledChatMessageSheet message={disabledReason} />
                  </Suspense>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
      {children}
    </div>
  );
}
