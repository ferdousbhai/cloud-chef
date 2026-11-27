import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { MenuItem } from '@ui/Menu';
import { authClient } from '~/lib/auth-client';
import { projectRoleSchema } from '~/lib/cloudflare/org-projects.client';
import { ImportFromGitHubDialog } from '~/components/projects/ImportFromGitHubDialog.client';
import { IMPORT_RETURN_PARAM, isImportReturn } from '~/lib/github-app.client';
import { openProjectWorkspace } from '~/lib/cloudflare/projects.client';
import { errorFeedback, FeedbackLine, type Feedback } from './Feedback';
import { noContentSchema, postJson, runRequest } from '~/lib/json-request';
import { MoreMenu, StatusBadge } from './SettingsLayout';

/** The GitHub accounts CloudChef's App is installed on for the team: imports read from all of them. */
export const orgGitHubSchema = z.array(
  z.object({ installationId: z.number(), accountLogin: z.string(), accountType: z.string() }),
);
export const orgProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The project's Artifacts repository; null until the first person to open it has imported it. */
  repo: z.string().nullable(),
  createdFrom: z.enum(['github', 'zip', 'copy', 'push', 'chat']),
  /** The GitHub repository it was imported from, for an imported project. */
  importRepoFullName: z.string().nullable(),
  access: z.array(z.object({ userId: z.string(), role: projectRoleSchema })),
});
const installStartedSchema = z.object({ installUrl: z.string() });

/**
 * GitHub, as a place projects are imported from: one line naming the GitHub accounts CloudChef's App reads, with
 * importing, adding one and disconnecting behind it. Projects themselves, and who is on each, are on the projects
 * home and in each project's sharing, not here.
 */
export function GitHubConnection({
  orgId,
  github,
  onChanged,
}: {
  orgId: string;
  github: z.infer<typeof orgGitHubSchema>;
  onChanged: () => Promise<void>;
}) {
  const [disconnecting, setDisconnecting] = useState<z.infer<typeof orgGitHubSchema>[number] | null>(null);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const onError = (message: string | null) => setFeedback(errorFeedback(message));
  // Importing acts in the account the person is working in now, so it's offered for that team only.
  const { data: session } = authClient.useSession();
  const workingHere = session?.context?.orgId === orgId;

  // Back from GitHub to the import dialog started here: it opens again, listing what was just connected, once the
  // session says this is the team being worked in.
  const [returnPending, setReturnPending] = useState(() => isImportReturn(window.location.search));
  if (returnPending && workingHere) {
    setReturnPending(false);
    setImporting(true);
  }
  useEffect(() => {
    if (importing && isImportReturn(window.location.search)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(IMPORT_RETURN_PARAM);
      url.searchParams.delete('github_message');
      window.history.replaceState(window.history.state, '', url);
    }
  }, [importing]);

  const connect = () =>
    void runRequest(async () => {
      const { installUrl } = await postJson(
        '/api/organizations/github/start',
        // Back to this Settings page itself, which says what GitHub's return did.
        { orgId, callbackURL: window.location.href },
        installStartedSchema,
      );
      window.location.assign(installUrl);
    }, onError);

  const disconnect = (installationId: number) =>
    void runRequest(async () => {
      await postJson('/api/organizations/github/disconnect', { orgId, installationId }, noContentSchema);
      setDisconnecting(null);
      await onChanged();
    }, onError);

  return (
    <div className="mt-3 grid min-w-0 gap-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-content-secondary">GitHub</span>
        {github.length === 0 ? (
          <StatusBadge>Not connected</StatusBadge>
        ) : (
          github.map((account) => (
            <StatusBadge key={account.installationId} tone="success">
              {account.accountLogin}
            </StatusBadge>
          ))
        )}
        <span className="ml-auto flex items-center gap-1">
          {workingHere ? (
            <Button size="xs" variant="neutral" onClick={() => setImporting(true)}>
              Import from GitHub
            </Button>
          ) : null}
          <MoreMenu title="More for GitHub">
            {github.length === 0 ? (
              <MenuItem action={connect}>Connect GitHub</MenuItem>
            ) : (
              <>
                <MenuItem action={connect}>Add GitHub accounts or repositories</MenuItem>
                {github.map((account) => (
                  <MenuItem key={account.installationId} danger action={() => setDisconnecting(account)}>
                    Disconnect {account.accountLogin}
                  </MenuItem>
                ))}
              </>
            )}
          </MoreMenu>
        </span>
      </div>
      <FeedbackLine feedback={feedback} className="" />
      {importing ? (
        <ImportFromGitHubDialog
          orgId={orgId}
          onOpenProject={openProjectWorkspace}
          onClose={() => setImporting(false)}
        />
      ) : null}
      {disconnecting ? (
        <ConfirmationDialog
          dialogTitle={`Disconnect ${disconnecting.accountLogin}?`}
          dialogBody={`Projects already imported stay as they are. Private repositories from github.com/${disconnecting.accountLogin} can't be imported until it's connected again.`}
          confirmText="Disconnect"
          onClose={() => setDisconnecting(null)}
          onConfirm={() => disconnect(disconnecting.installationId)}
        />
      ) : null}
    </div>
  );
}
