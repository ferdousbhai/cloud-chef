import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientReports } from '~/components/ClientRouteComponents';
import { SignInPrompt } from '~/components/SignInPrompt';
import { Loading } from '~/components/Loading';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { createPrivatePageHead } from '~/lib/social-meta';

/** CloudChef's operators' page for reported posts and comments; the routes behind it refuse anyone else. */
export const Route = createFileRoute('/reports')({
  head: () => createPrivatePageHead('Reports | CloudChef', 'Reported posts and comments.'),
  component: ReportsPage,
});

function ReportsPage() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return <SignInPrompt title="Sign in to see reports." returnTo="/reports" />;
  }
  return (
    <ShowcaseShell>
      <ClientReports />
    </ShowcaseShell>
  );
}
