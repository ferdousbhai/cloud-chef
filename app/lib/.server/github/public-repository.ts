/** A GitHub repository named by its address: `owner/name`. */
const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** How much of git's ref advertisement is read for the default branch: it comes on the first ref's line. */
const MAX_ADVERTISEMENT_BYTES = 64 * 1024;

/** `owner/name` from a github.com repository address, or null for anything else. */
export function gitHubRepositoryFromUrl(value: string): string | null {
  const match = GITHUB_REPOSITORY_URL.exec(value.trim());
  if (!match || match[2] === '.' || match[2] === '..') {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * A public GitHub repository's default branch, read as git reads it (the ref advertisement's `HEAD`
 * symref), so no GitHub API allowance is spent. Null when the repository is private, missing, or empty:
 * GitHub answers git without credentials only for a public repository.
 */
export async function publicRepositoryDefaultBranch(
  fullName: string,
  request: typeof fetch = fetch,
): Promise<string | null> {
  // A renamed or moved repository's old address redirects to its new one on github.com: that is followed, a
  // few times at most, and nowhere else.
  let url = `https://github.com/${fullName}.git/info/refs?service=git-upload-pack`;
  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    response = await request(url, {
      headers: { 'User-Agent': 'git/2.47.0 (CloudChef)', 'Git-Protocol': 'version=1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location || redirects >= 3) {
      break;
    }
    const next = new URL(location, url);
    await response.body?.cancel().catch(() => undefined);
    if (next.origin !== 'https://github.com') {
      return null;
    }
    url = next.href;
  }
  if (response.status === 429 || response.status >= 500) {
    // github.com busy or failing says nothing about whether the repository is public.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`github.com answered ${response.status}`);
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < MAX_ADVERTISEMENT_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      // Only once the name has ended: a chunk may stop partway through it.
      const branch = /symref=HEAD:refs\/heads\/([^\s\0]+)[\s\0]/.exec(text)?.[1];
      if (branch) {
        return branch;
      }
    }
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
