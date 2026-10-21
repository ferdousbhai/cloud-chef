/**
 * What a return from GitHub (connecting it, or approving a production request) tells Settings. The
 * URL carries only a code, and Settings shows its fixed text: a link can't put words of its own on
 * CloudChef's page.
 */
const GITHUB_RETURN_MESSAGES = {
  returned: 'Back from GitHub. Repository access you changed there applies to your linked projects.',
  install_expired: 'That GitHub connection expired or was already finished. Connect GitHub again.',
  install_cancelled: 'GitHub was not connected: the installation was cancelled. Connect GitHub again.',
  install_other_admin: 'Only the admin who started connecting GitHub can finish it.',
  install_not_owner: 'Only the owner of that GitHub account or organization can connect it.',
  install_failed: 'GitHub refused the connection. Connect GitHub again.',
  connected: 'Connected GitHub.',
  approval_cancelled: 'GitHub authorization was cancelled.',
  approval_other_admin: 'Only the admin who started the approval can finish it.',
  github_disconnected: 'GitHub is no longer connected.',
  approval_changed: 'That request was decided, or changed, while you were on GitHub. Review it and approve again.',
  approval_wrong_account:
    "Sign in to GitHub as the account CloudChef's GitHub App is installed on to create the repository there.",
  repository_name_refused: 'GitHub refused that repository name. Approve again with another.',
  repository_unreachable:
    "The repository is on GitHub, but CloudChef's GitHub App can't reach it. On GitHub, add it to the App's " +
    'repository access (your settings, Applications, Configure), then approve again with the same name.',
  repository_not_ready: 'GitHub created the repository but not its first branch yet. Approve again in a minute.',
  repository_name_taken: 'A repository with that name already exists. Approve again with another name.',
  draft_too_large: 'This draft is larger than CloudChef can commit. Ask the member to slim it down and send it again.',
  approval_failed: 'GitHub refused part of the approval. Approve again.',
  approved: 'The app is now a GitHub repository, and a project its requester can work on.',
} as const;

export type GitHubReturnMessage = keyof typeof GITHUB_RETURN_MESSAGES;

const messages = new Map<string, string>(Object.entries(GITHUB_RETURN_MESSAGES));

/** The text for a code from Settings' URL, or null for anything that isn't one. */
export function gitHubReturnMessageText(code: string): string | null {
  return messages.get(code) ?? null;
}
