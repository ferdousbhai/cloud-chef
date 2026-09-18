import { createFileRoute } from '@tanstack/react-router';
import { ClientExistingChat, ClientHeader } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';
import { ChatIdProvider } from '~/lib/stores/chatId';

export const Route = createFileRoute('/chat/$id')({
  head: () => createPrivatePageHead('Project | CloudChef', 'Open a private CloudChef project workspace.'),
  component: ChatRoute,
});

function ChatRoute() {
  const { id } = Route.useParams();

  return (
    <ChatIdProvider key={id} chatId={id}>
      <div className="flex size-full flex-col bg-bolt-elements-background-depth-1">
        <ClientHeader />
        <ClientExistingChat chatId={id} />
      </div>
    </ChatIdProvider>
  );
}
