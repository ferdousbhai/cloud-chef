import { createFileRoute } from '@tanstack/react-router';
import { ClientHeader, ClientHomepage } from '~/components/ClientRouteComponents';
import { createSocialPageHead } from '~/lib/social-meta';
import { TrustFooter } from '~/components/trust/TrustLinks';
import { ChatIdProvider } from '~/lib/stores/chatId';
import { useState } from 'react';

export const Route = createFileRoute('/')({
  loader: () => ({ initialId: crypto.randomUUID() }),
  head: () =>
    createSocialPageHead({
      title: 'CloudChef | Build and ship Cloudflare apps',
      description: 'Build and ship Cloudflare apps with CloudChef, the full-stack AI coding agent.',
      path: '/',
      imagePath: '/social-preview-home-v2.png',
      imageAlt: 'CloudChef — build and ship Cloudflare apps',
    }),
  component: Index,
});

// The home page preserves the initial prompt while Cloudflare authentication is established. After
// starting the chat, all global in-memory state is preserved as it switches to
// the chat view. The router stays on this runtime route and masks the published
// URL as `/chat/$id`; reloading that URL uses the existing-chat route below.
// This route is optimized for making the initial experience seamless.
//
function Index() {
  const { initialId } = Route.useLoaderData();
  return <IndexShell initialId={initialId} />;
}

export function IndexShell({ initialId }: { initialId: string }) {
  // Publishing the masked resumable URL revalidates the active `/` loader.
  // The mounted live build must keep the identity it started with.
  const [chatId] = useState(initialId);

  return (
    <ChatIdProvider key={chatId} chatId={chatId}>
      <div className="flex size-full flex-col bg-bolt-elements-background-depth-1">
        <ClientHeader />
        <ClientHomepage initialId={chatId} />
        <TrustFooter />
      </div>
    </ChatIdProvider>
  );
}
