/** A space a person builds in, as far as naming it goes. */
type NamedWorkspace = { orgName: string; solo: boolean };

/** What a space of a person's own is called wherever spaces are named. */
export const PERSONAL_WORKSPACE_NAME = 'Personal';

/**
 * What a space is called to the person building in it, among `all` the spaces they can build in. One they are
 * alone in is Personal, since to them it is their own account; a space with other people in it goes by its name,
 * which those people see. Alone in more than one, each goes by its name, so no two are called Personal.
 */
export function workspaceName(option: NamedWorkspace, all: readonly NamedWorkspace[]): string {
  return option.solo && all.filter((other) => other.solo).length <= 1 ? PERSONAL_WORKSPACE_NAME : option.orgName;
}

/** What a space made for one person is called until they rename it: theirs, by their first name. */
export function spaceNameFor(personName: string): string {
  const firstName = personName.trim().split(/\s+/)[0]?.slice(0, 40);
  return firstName ? `${firstName}’s space` : 'My space';
}
