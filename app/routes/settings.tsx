import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '~/lib/auth-client';
import { ClientSettingsContent } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';
import { Loading } from '~/components/Loading';
import { SignInPrompt } from '~/components/SignInPrompt';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE,
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
  CLOUDFLARE_CONNECT_MESSAGE_PARAM,
  cloudflareConnectMessageText,
} from '~/lib/cloudflare/authorization-recovery';
import { z } from 'zod';

const settingsSearchSchema = z.object({
  [CLOUDFLARE_AUTHORIZATION_ERROR_PARAM]: z.string().optional().catch(undefined),
  [CLOUDFLARE_CONNECT_MESSAGE_PARAM]: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>) => settingsSearchSchema.parse(search),
  head: () => createPrivatePageHead('Settings | CloudChef', 'Manage your CloudChef and Cloudflare connection.'),
  component: Settings,
});

function Settings() {
  // Settings is where someone signed in without a Cloudflare account creates an organization or
  // connects one, so it opens for any session, not only one with an account to build in.
  const { data: session, isPending } = authClient.useSession();
  const search = Route.useSearch();
  // The URL names a code; only CloudChef's own text for it is shown.
  const authorizationError =
    (search.cloudflare_message ? cloudflareConnectMessageText(search.cloudflare_message) : null) ??
    (search.cloudflare_authorization === CLOUDFLARE_AUTHORIZATION_ERROR_VALUE
      ? CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE
      : null);
  return (
    <SettingsRouteView
      authKind={isPending ? 'loading' : session ? 'fullyLoggedIn' : 'unauthenticated'}
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
    return <Loading message="Checking your session…" />;
  }
  if (authKind === 'unauthenticated') {
    return <SignInPrompt title="Sign in to open settings." initialError={authorizationError} />;
  }
  return <ClientSettingsContent authorizationError={authorizationError} />;
}
