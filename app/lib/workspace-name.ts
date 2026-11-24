/** An account a person builds in, as far as naming it goes. */
type NamedWorkspace = { kind: 'personal' } | { kind: 'organization'; orgName: string; solo: boolean };

/** What a person's own account is called wherever accounts are named. */
export const PERSONAL_WORKSPACE_NAME = 'Personal';

/**
 * What an account is called to the person building in it, among `all` the accounts they can build in: their own
 * Cloudflare account is Personal, and so is a space CloudChef runs while they are alone in it, since to them that
 * is their own account too. A team goes by its name, as does a space of theirs with other people in it, and a
 * space of theirs beside a Cloudflare account of their own, so no two are called Personal.
 */
export function workspaceName(option: NamedWorkspace, all: readonly NamedWorkspace[]): string {
  if (option.kind === 'personal') {
    return PERSONAL_WORKSPACE_NAME;
  }
  return option.solo && !all.some((other) => other.kind === 'personal') ? PERSONAL_WORKSPACE_NAME : option.orgName;
}
