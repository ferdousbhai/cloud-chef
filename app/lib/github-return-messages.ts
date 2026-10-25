/**
 * What a return from GitHub (connecting it) tells Settings. The
 * URL carries only a code, and Settings shows its fixed text: a link can't put words of its own on
 * CloudChef's page.
 */
const GITHUB_RETURN_MESSAGES = {
  returned: 'Back from GitHub. Repository access you changed there applies to what you can import.',
  install_expired: 'That GitHub connection expired or was already finished. Try again.',
  install_cancelled: 'GitHub was not connected: the installation was cancelled. Try again.',
  install_other_admin:
    'Connecting GitHub has to be finished by the person who started it, while they still manage this account (Personal, or as a team admin). Sign in as them, then connect it again.',
  install_already_there:
    "That GitHub account already has CloudChef's GitHub App, so GitHub didn't ask its owner to confirm it. If it's a personal GitHub account someone else set up, ask them to add it here. Otherwise its owner uninstalls CloudChef's App on GitHub (in the account's or organization's settings, under Applications or GitHub Apps), then connects it again here.",
  install_organization_elsewhere:
    "That GitHub organization is already connected in Personal or one of your teams, and for now an organization can be connected in only one of them at a time. Disconnect it there first, then uninstall CloudChef's App in the organization's settings on GitHub (GitHub Apps) and connect it here.",
  install_not_owner: 'Only the owner of that GitHub account or organization can connect it.',
  install_failed: "GitHub couldn't be connected just now. Try again.",
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
  "give CloudChef's GitHub App access from Import from GitHub on the home page (in a team, only an admin can do this)";

/** The same, said inside the import dialog, whose button just below gives the App access. */
export const IMPORT_DIALOG_ACCESS_FIX = "use the GitHub button below to give CloudChef's GitHub App access to it";

/** GitHub not answering, or limiting how often it is asked: a passing failure, worth trying again. */
export const GITHUB_UNREACHABLE = 'GitHub could not be reached just now. Try again in a moment.';
