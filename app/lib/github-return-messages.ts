/**
 * What a return from GitHub (connecting it) tells Settings. The
 * URL carries only a code, and Settings shows its fixed text: a link can't put words of its own on
 * CloudChef's page.
 */
const GITHUB_RETURN_MESSAGES = {
  returned: 'Back from GitHub. Repository access you changed there applies to what you can import.',
  install_expired: 'That GitHub connection expired or was already finished. Connect GitHub again.',
  install_cancelled: 'GitHub was not connected: the installation was cancelled. Connect GitHub again.',
  install_other_admin: 'Only the admin who started connecting GitHub can finish it.',
  install_not_owner: 'Only the owner of that GitHub account or organization can connect it.',
  install_failed: 'GitHub refused the connection. Connect GitHub again.',
  connected: 'Connected GitHub.',
  repositories_updated: 'Updated which repositories CloudChef can reach on GitHub.',
} as const;

export type GitHubReturnMessage = keyof typeof GITHUB_RETURN_MESSAGES;

const messages = new Map<string, string>(Object.entries(GITHUB_RETURN_MESSAGES));

/** The text for a code from Settings' URL, or null for anything that isn't one. */
export function gitHubReturnMessageText(code: string): string | null {
  return messages.get(code) ?? null;
}

/** Where a person gives CloudChef's GitHub App another account or repository, said in errors that need it. */
export const GITHUB_ACCESS_FIX =
  "give CloudChef's GitHub App access from Import from GitHub, or for a team in Settings, in the menu beside the team's projects";
