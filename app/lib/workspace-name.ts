/** An account a person works in, as far as naming it goes. */
type NamedWorkspace = { orgName: string; personal: boolean };

/** What a person's own account is called wherever accounts are named. */
export const PERSONAL_WORKSPACE_NAME = 'Personal';

/**
 * What an account is called to the person working in it: their own is Personal, whoever else is on its projects;
 * someone else's goes by its name, which says whose it is.
 */
export function workspaceName(option: NamedWorkspace): string {
  return option.personal ? PERSONAL_WORKSPACE_NAME : option.orgName;
}

/** What a person's own account is called to the people added to its projects: theirs, by their first name. */
export function spaceNameFor(personName: string): string {
  const firstName = personName.trim().split(/\s+/)[0]?.slice(0, 40);
  return firstName ? `${firstName}’s account` : 'My account';
}
