import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientFeed } from '~/components/ClientRouteComponents';
import { SignInPrompt } from '~/components/SignInPrompt';
import { Loading } from '~/components/Loading';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { createPrivatePageHead } from '~/lib/social-meta';

export const Route = createFileRoute('/feed')({
  head: () => createPrivatePageHead('Feed | CloudChef', 'What the people you follow made.'),
  component: FeedPage,
});

function FeedPage() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return <SignInPrompt title="Sign in to see what the people you follow made." returnTo="/feed" />;
  }
  return (
    <ShowcaseShell>
      <ClientFeed />
    </ShowcaseShell>
  );
}
