/**
 * A person's name as others on a project see it: their name as stored, but never an email address. A stored name can
 * be one (a Cloudflare profile may report its email as the name), so only the part before the @ is shown, as written.
 */
export function shownName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.includes('@')) {
    return trimmed || 'Someone';
  }
  return trimmed.split('@')[0]!.trim() || 'Someone';
}
