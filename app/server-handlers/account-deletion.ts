import { z } from 'zod';
import { clearAuthSessionCookie } from '~/lib/.server/auth';
import { requireRecentlyAuthenticatedSession } from '~/lib/.server/account-reauthentication';
import { eraseControlPlaneAccount, OrganizationAdminRequiredError } from '~/lib/.server/cloudflare/account-deletion';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';

const MAX_ACCOUNT_DELETION_BYTES = 1024;
const accountDeletionSchema = z
  .object({
    confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION),
    acknowledgeCloudflareResourcesRetained: z.literal(true),
  })
  .strict();

export async function deleteAccountAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await requireRecentlyAuthenticatedSession(
    env,
    request,
    'Sign in again to confirm it is you, then delete your CloudChef account data.',
  );
  if (session instanceof Response) {
    return session;
  }
  const confirmation = accountDeletionSchema.safeParse(
    await readJsonBodyWithLimit(request, MAX_ACCOUNT_DELETION_BYTES, 'Account deletion request').catch(() => null),
  );
  if (!confirmation.success) {
    return Response.json(
      { error: 'Confirm the exact phrase and the retained-resources acknowledgement.' },
      { status: 400 },
    );
  }

  let erasure: Awaited<ReturnType<typeof eraseControlPlaneAccount>>;
  try {
    erasure = await eraseControlPlaneAccount({ env, userId: session.user.id });
  } catch (error) {
    if (error instanceof OrganizationAdminRequiredError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  console.info({
    event: 'control_plane_account_erased',
    erasedAt: new Date().toISOString(),
    cloudflareAuthorizationRevoked: erasure.cloudflareAuthorizationRevoked,
  });
  return Response.json(
    {
      status: 'deleted',
      cloudflareAuthorizationRevoked: erasure.cloudflareAuthorizationRevoked,
      cloudflareAuthorizationsKept: erasure.cloudflareAuthorizationsKept,
      workspacesLeftIn: erasure.workspacesLeftIn,
    },
    { headers: { 'Set-Cookie': clearAuthSessionCookie(request), 'Cache-Control': 'no-store' } },
  );
}
