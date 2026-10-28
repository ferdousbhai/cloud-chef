import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientApprovals, ClientHeader } from '~/components/ClientRouteComponents';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Loading } from '~/components/Loading';
import { createPrivatePageHead } from '~/lib/social-meta';

export const Route = createFileRoute('/approvals')({
  head: () => createPrivatePageHead('Approvals | CloudChef', 'What your teams’ members asked an admin for.'),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return <CloudflareSignInPrompt title="Sign in to see approvals." returnTo="/approvals" />;
  }
  return (
    <div className="flex size-full flex-col overflow-y-auto bg-bolt-elements-background-depth-1">
      <ClientHeader />
      <ClientApprovals />
    </div>
  );
}
