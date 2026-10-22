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
  messagesLength: number;
  onSend: (messageInput: string, onAccepted?: () => void) => Promise<boolean>;
  onStop: () => void;
  sendMessageInProgress: boolean;
  /** The home page, where a new app starts; not a project's own empty chat. */
  homepage?: boolean;
}

export function HomeIntro({
  disabledReason,
  isStreaming,
  messagesLength,
  onSend,
  onStop,
  sendMessageInProgress,
  homepage = false,
}: HomeIntroProps) {
  const { data: session } = authClient.useSession();
  // A member whose organization limits them to its GitHub projects can't start a new app here.
  const projectsOnly =
    homepage && session?.context?.kind === 'organization' && !session.context.draftsAllowed
      ? session.context.orgName
      : null;
  return (
    <div className="cloudchef-home-shell grow p-4 sm:px-6 lg:px-8">
      <section className="cloudchef-home-copy min-w-0" aria-labelledby="intro">
        <div className="cloudchef-home-hero">
          <div className="min-w-0">
            <HomeHeroCopy headingId="intro" />

            {projectsOnly !== null ? (
              <div className="cloudchef-home-composer-stack" role="status">
                <p className="app-page-lede mx-auto break-words text-center">
                  {projectsOnly} lets you work on its GitHub projects. Open the project menu (top left) and choose one
                  to start.
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
                  numMessages={messagesLength}
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
    </div>
  );
}
