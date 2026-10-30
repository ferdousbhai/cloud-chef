/**
 * The confirmation phrase the settings control asks for and the handler enforces.
 * It lives here because those two sides span the client/server boundary and the
 * phrase has to be identical on both.
 */
export const ACCOUNT_DELETION_CONFIRMATION = 'delete my CloudChef account';

/**
 * What each section of the account export holds, in the words Settings uses to name one it couldn't
 * read. The export and Settings share this so a section added to one is named in the other.
 */
const ACCOUNT_EXPORT_SECTION_LABELS = {
  account: 'your account record',
  cloudflareConnection: 'your Cloudflare connection',
  encryptedCredential: 'CloudChef’s stored access to the Cloudflare account you build in',
  computerRuntimes: 'your workspaces',
  organizations: 'your team memberships',
  organizationInvites: 'invites sent to you',
  organizationQuotaEvents: 'the invites you sent and teams you created, as counted toward their limits',
  organizationUsage: 'your model use in teams',
  organizationProjects: 'your projects, and the team projects you were given',
  githubConnections: 'your GitHub connections in progress',
  emailSignInLinks: 'your emailed sign-in links',
  authSessions: 'your sign-in sessions',
  oauthStates: 'your Cloudflare authorizations in progress',
  showcase: 'your page, posts, comments, follows and likes',
} as const;

export type AccountExportSectionName = keyof typeof ACCOUNT_EXPORT_SECTION_LABELS;

/** A section's readable name; one Settings doesn't know is shown as the export names it. */
export function accountExportSectionLabel(section: string): string {
  return Object.entries(ACCOUNT_EXPORT_SECTION_LABELS).find(([name]) => name === section)?.[1] ?? section;
}
