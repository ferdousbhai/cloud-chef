import type { ReactNode } from 'react';
import { CodeIcon, CopyIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import type { BuilderLinkedProjectSummary } from '~/agents/conversation-agent';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { selectWorkspaceSurface } from '~/lib/stores/workspace-surface.client';
import { DisabledChatMessageSheet } from './DisabledChatMessageSheet';
import { MessageInput } from './MessageInput';

/**
 * The first thing a team project's chat shows: which project this is and how a change goes live,
 * instead of the homepage's invitation to describe a new app.
 */
export function LinkedProjectIntro({
  linkedProject,
  disabledReason,
  isStreaming,
  onSend,
  onStop,
  sendMessageInProgress,
}: {
  linkedProject: BuilderLinkedProjectSummary;
  disabledReason: ReactNode | null;
  isStreaming: boolean;
  onSend: (messageInput: string, onAccepted?: () => void) => Promise<boolean>;
  onStop: () => void;
  sendMessageInProgress: boolean;
}) {
  const { repository, viewOnly } = linkedProject;
  return (
    <div className="cloudchef-home-shell grow p-4 sm:px-6 lg:px-8">
      <section className="cloudchef-home-copy min-w-0" aria-labelledby="linked-intro">
        <div className="cloudchef-home-hero">
          <div className="min-w-0">
            <h1 id="linked-intro" className="cloudchef-home-title wrap-break-word">
              {viewOnly ? 'Looking at' : 'Working on'} {repository}
            </h1>
            <p className="mt-3 max-w-xl text-balance text-sm text-content-secondary">
              {viewOnly
                ? 'You can view this project but not change it. Ask how it works here. To change it, make a copy: the copy is your own project, with its own site.'
                : 'Ask for a change. To check it first, ask for a preview: a copy of the site with your change, at its own link. When it looks right, ask to publish and the live site updates.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="neutral" icon={<CodeIcon />} onClick={() => selectWorkspaceSurface('code')}>
                Browse the code
              </Button>
              {viewOnly ? (
                <Button size="sm" variant="neutral" icon={<CopyIcon />} onClick={() => projectDialogStore.set('copy')}>
                  Make a copy
                </Button>
              ) : null}
            </div>

            <div className="cloudchef-home-composer-stack">
              <MessageInput
                chatStarted={false}
                isStreaming={isStreaming}
                sendMessageInProgress={sendMessageInProgress}
                disabled={disabledReason !== null}
                onStop={onStop}
                onSend={onSend}
                hasMessages={false}
                placeholder={viewOnly ? `Ask about ${repository}` : `What should change in ${repository}?`}
              />
              <DisabledChatMessageSheet message={disabledReason} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
