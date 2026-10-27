import { useExistingChat } from '~/lib/stores/startup';
import { Chat, WorkspaceRuntimeConnectionError } from './chat/Chat';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { Loading } from './Loading';
import { Toaster } from '~/components/ui/Toaster';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { useStore } from '@nanostores/react';
import {
  retryAfterRuntimeError,
  UserRuntimeSessionError,
  userWorkspacePreparingStore,
} from '~/lib/cloudflare/runtime-session';
import { isWorkspacePreparingError } from '~/lib/cloudflare/client';
import { WorkspacePreparingLoading, WorkspacePreparingPanel } from '~/components/WorkspacePreparing';
import { PromptPrefillContext } from './chat/prompt-prefill';

export function ExistingChat({ chatId }: { chatId: string }) {
  return (
    <>
      <ExistingChatSessionView chatId={chatId} />
      <Toaster />
    </>
  );
}

function ExistingChatSessionView({ chatId }: { chatId: string }) {
  const userId = useUserIdOrNullOrLoading();
  if (userId === undefined) {
    return <Loading message="Checking your Cloudflare session…" />;
  }
  if (userId === null) {
    return (
      <CloudflareSignInPrompt
        title="Connect Cloudflare to open this project."
        description="Connect the Cloudflare account that owns this project."
      />
    );
  }

  return <AuthenticatedExistingChat chatId={chatId} />;
}

function AuthenticatedExistingChat({ chatId }: { chatId: string }) {
  const {
    initialMessages,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    transcript,
    loadError,
    retryLoad,
    subchatLoadError,
    retrySubchats,
  } = useExistingChat(chatId);

  if (loadError && initialMessages == null) {
    return <ProjectLoadError error={loadError} onRetry={retryLoad} />;
  }
  if (initialMessages === null) {
    return <NotFound />;
  }
  if (subchatLoadError && subchats === undefined) {
    return <ProjectLoadError error={subchatLoadError} onRetry={retrySubchats} />;
  }

  // Wait for the account-owned chat and workbench state without running any actions.
  if (initialMessages === undefined || !transcript) {
    return <ProjectLoading />;
  }
  return (
    // The homepage's draft belongs to a new project, not to this one.
    <PromptPrefillContext.Provider value={false}>
      <Chat
        initialMessages={initialMessages}
        initializeChat={initializeChat}
        discardEmptyChat={discardEmptyChat}
        onBuilderRequestStart={onBuilderRequestStart}
        subchats={subchats}
        transcript={transcript}
      />
    </PromptPrefillContext.Provider>
  );
}

/** The load is indistinguishable from any other until the runtime says it is still provisioning. */
function ProjectLoading() {
  const preparing = useStore(userWorkspacePreparingStore);
  return preparing ? <WorkspacePreparingLoading /> : <Loading message="Loading project…" />;
}

export function ProjectLoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const message = error.message;
  const retry = () => retryAfterRuntimeError(error, onRetry);
  if (isWorkspacePreparingError(error)) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5">
        <WorkspacePreparingPanel onKeepWaiting={retry} />
      </div>
    );
  }
  // A refusal that waits on the person (new Cloudflare permissions, the Workers plan) says what to do, with its button.
  if (error instanceof UserRuntimeSessionError && error.code) {
    return (
      <WorkspaceRuntimeConnectionError
        message={message}
        code={error.code}
        upgradeUrl={error.upgradeUrl}
        onRetry={retry}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <section
        className="app-card m-auto w-full max-w-lg shrink-0 p-5 text-center"
        aria-labelledby="project-load-heading"
      >
        <h1 id="project-load-heading" className="font-display text-2xl font-bold text-content-primary">
          CloudChef could not load this project.
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm break-words text-content-secondary" role="alert">
          {message}
        </p>
        <Button className="mt-4" onClick={retry}>
          Try again
        </Button>
      </section>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <section
        className="app-card m-auto w-full max-w-lg shrink-0 p-5 text-center"
        aria-labelledby="project-not-found-heading"
      >
        <h1
          id="project-not-found-heading"
          className="font-display text-2xl font-bold tracking-tight text-content-primary"
        >
          This project could not be found.
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-balance text-content-secondary">
          It may have been deleted, or it may belong to a different Cloudflare account.
        </p>
        <LinkButton to="/" className="mt-4">
          Start a new project
        </LinkButton>
      </section>
    </div>
  );
}
