/**
 * A person's username, as in their projects' addresses (`<username>/<project>`): 1 to 39 lowercase letters, digits
 * and single dashes, not starting or ending with one, as GitHub's. Names CloudChef's own pages use are kept back: a
 * person's page is at `/<username>`, so every top-level page CloudChef has, or may add, is named here first.
 */
const USERNAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const RESERVED = new Set([
  'about',
  'admin',
  'api',
  'app',
  'approvals',
  'assets',
  'chat',
  'cli',
  'cloudchef',
  'connect',
  'copy',
  'explore',
  'feed',
  'followers',
  'following',
  'git',
  'help',
  'home',
  'install',
  'join',
  'login',
  'media',
  'new',
  'notifications',
  'post',
  'posts',
  'privacy',
  'projects',
  'reports',
  'search',
  'security',
  'settings',
  'showcase',
  'sign-in',
  'support',
  'teams',
  'terms',
]);

/** Why `username` can't be one, in a sentence, or null when it can. */
export function usernameProblem(username: string): string | null {
  if (!USERNAME.test(username)) {
    return 'Use up to 39 lowercase letters, numbers and single dashes, starting and ending with a letter or number.';
  }
  return RESERVED.has(username) ? 'That name is kept for CloudChef itself. Choose another.' : null;
}

/** A suggestion from the person's name or email: what they type is checked as they go. */
export function suggestedUsername(from: string): string {
  return (
    from
      .split('@')[0]!
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 39)
      .replace(/-+$/, '') || ''
  );
}
