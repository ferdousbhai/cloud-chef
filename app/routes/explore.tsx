import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientExplore, ClientHeader } from '~/components/ClientRouteComponents';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Loading } from '~/components/Loading';
import { createPrivatePageHead } from '~/lib/social-meta';

export const Route = createFileRoute('/explore')({
  head: () => createPrivatePageHead('Explore | CloudChef', 'Projects people have made public on CloudChef.'),
  component: ExplorePage,
});

function ExplorePage() {
  // Public projects are for anyone signed in, whether or not they have a Cloudflare account to copy into yet.
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return <CloudflareSignInPrompt title="Sign in to explore public projects." returnTo="/explore" />;
  }
  return (
    <div className="flex size-full flex-col overflow-y-auto bg-bolt-elements-background-depth-1">
      <ClientHeader />
      <ClientExplore />
    </div>
  );
}
