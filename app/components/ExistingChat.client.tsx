import { useExistingChat } from '~/lib/stores/startup';
import { Chat } from './chat/Chat';
import { CloudChefAuthProvider } from './chat/CloudChefAuthWrapper';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { Loading } from './Loading';
import { useReloadMessages } from '~/lib/stores/startup/reloadMessages';
import { UserProvider } from '~/components/UserProvider';
import { Toaster } from '~/components/ui/Toaster';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { useStore } from '@nanostores/react';
import {
  getUserRuntimeSession,
  UserRuntimeSessionError,
  userWorkspacePreparingStore,
} from '~/lib/cloudflare/runtime-session';
import { isWorkspacePreparingError } from '~/lib/cloudflare/client';
import { WORKSPACE_PREPARING_MESSAGE, WorkspacePreparingPanel } from '~/components/WorkspacePreparing';

export function ExistingChat({ chatId }: { chatId: string }) {
  return (
    <>
      <CloudChefAuthProvider>
        <UserProvider>
          <ExistingChatSessionView chatId={chatId} />
        </UserProvider>
      </CloudChefAuthProvider>
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

  const reloadState = useReloadMessages(initialMessages ?? undefined);

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
  if (initialMessages === undefined || !transcript || reloadState === undefined) {
    return <ProjectLoading />;
  }
  return (
    <Chat
      initialMessages={initialMessages}
      partCache={reloadState.partCache}
      initializeChat={initializeChat}
      discardEmptyChat={discardEmptyChat}
      onBuilderRequestStart={onBuilderRequestStart}
      subchats={subchats}
      transcript={transcript}
    />
  );
}

/** The load is indistinguishable from any other until the runtime says it is still provisioning. */
function ProjectLoading() {
  const preparing = useStore(userWorkspacePreparingStore);
  return <Loading message={preparing ? WORKSPACE_PREPARING_MESSAGE : 'Loading project…'} />;
}

export function ProjectLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : 'The project data could not be loaded.';
  const retry = () => {
    if (error instanceof UserRuntimeSessionError) {
      void getUserRuntimeSession({ retryProvisioning: true }).then(onRetry, onRetry);
      return;
    }
    onRetry();
  };
  if (isWorkspacePreparingError(error)) {
    return (
      <div className="flex h-full items-center justify-center p-5">
        <WorkspacePreparingPanel onKeepWaiting={retry} />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-5">
      <section className="app-card w-full max-w-xl p-6 text-center sm:p-8" aria-labelledby="project-load-heading">
        <p className="app-page-eyebrow">Project unavailable</p>
        <h1 id="project-load-heading" className="mt-2 font-display text-4xl font-black text-content-primary">
          CloudChef could not load this project.
        </h1>
        <p className="mx-auto mt-4 max-w-md break-words text-content-secondary" role="alert">
          {message}
        </p>
        <Button className="mt-6" onClick={retry}>
          Try again
        </Button>
      </section>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-5">
      <section className="app-card w-full max-w-xl p-6 text-center sm:p-8" aria-labelledby="project-not-found-heading">
        <p className="app-page-eyebrow">Project unavailable</p>
        <h1
          id="project-not-found-heading"
          className="mt-2 font-display text-4xl font-black tracking-tight text-content-primary"
        >
          This project could not be found.
        </h1>
        <p className="mx-auto mt-4 max-w-md text-balance text-content-secondary">
          It may have been deleted, or it may belong to a different Cloudflare account.
        </p>
        <LinkButton to="/" className="mt-6">
          Start a new project
        </LinkButton>
      </section>
    </div>
  );
}
