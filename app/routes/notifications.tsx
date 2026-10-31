import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientNotifications } from '~/components/ClientRouteComponents';
import { SignInPrompt } from '~/components/SignInPrompt';
import { Loading } from '~/components/Loading';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { createPrivatePageHead } from '~/lib/social-meta';

export const Route = createFileRoute('/notifications')({
  head: () =>
    createPrivatePageHead(
      'Notifications | CloudChef',
      'Who followed you, and liked, commented on or copied your work.',
    ),
  component: NotificationsPage,
});

function NotificationsPage() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return <SignInPrompt title="Sign in to see your notifications." returnTo="/notifications" />;
  }
  return (
    <ShowcaseShell>
      <ClientNotifications />
    </ShowcaseShell>
  );
}
