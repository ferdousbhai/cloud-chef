import { CloudChefAuthProvider, useCloudChefAuth } from '~/components/chat/CloudChefAuthWrapper';
import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientSettingsContent } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';
import { Loading } from '~/components/Loading';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE,
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
} from '~/lib/cloudflare/authorization-recovery';

type SettingsSearch = {
  cloudflare_authorization?: string;
};

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>): SettingsSearch =>
    typeof search[CLOUDFLARE_AUTHORIZATION_ERROR_PARAM] === 'string'
      ? { cloudflare_authorization: search[CLOUDFLARE_AUTHORIZATION_ERROR_PARAM] }
      : {},
  head: () => createPrivatePageHead('Settings | CloudChef', 'Manage your CloudChef and Cloudflare connection.'),
  component: Settings,
});

function Settings() {
  return (
    <CloudChefAuthProvider>
      <SettingsRouteContent />
    </CloudChefAuthProvider>
  );
}

function SettingsRouteContent() {
  const auth = useCloudChefAuth();
  // Settings is where someone signed in without a Cloudflare account creates an organization or
  // connects one, so it opens for any session, not only one with an account to build in.
  const { data: session, isPending } = authClient.useSession();
  const search = Route.useSearch();
  const authorizationError =
    search.cloudflare_authorization === CLOUDFLARE_AUTHORIZATION_ERROR_VALUE
      ? CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE
      : null;
  return (
    <SettingsRouteView
      authKind={auth.kind === 'unauthenticated' && session && !isPending ? 'fullyLoggedIn' : auth.kind}
      authorizationError={authorizationError}
    />
  );
}

function SettingsRouteView({
  authKind,
  authorizationError = null,
}: {
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn';
  authorizationError?: string | null;
}) {
  if (authKind === 'loading') {
    return <Loading message="Checking your Cloudflare session…" />;
  }
  if (authKind === 'unauthenticated') {
    return <CloudflareSignInPrompt title="Connect Cloudflare to open settings." initialError={authorizationError} />;
  }
  return <ClientSettingsContent authorizationError={authorizationError} />;
}
