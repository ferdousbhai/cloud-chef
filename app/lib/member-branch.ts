/**
 * A member's branch on a team project's repository: `cloudchef/<email's name part, made safe for git>-<the
 * start of their user id>`, then the workspace's key, so each conversation has its own. Without a key
 * (a workspace opened before branches were per conversation), the member's one branch.
 */
export function memberBranch(member: { email: string; userId: string }, branchKey: string | undefined): string {
  const name = (member.email.split('@')[0] ?? 'member')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const branch = `cloudchef/${name || 'member'}-${member.userId
    .slice(0, 6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0')}`;
  return branchKey ? `${branch}-${branchKey}` : branch;
}
