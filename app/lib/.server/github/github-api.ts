import type { z } from 'zod';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** A GitHub request that failed: `status` is GitHub's, or 502 for a response CloudChef couldn't read. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** GitHub limiting how often it is asked (a 429, or a 403 with no requests left or a wait): it passes. */
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

export type GitHubRequestInit = { method?: string; body?: string };

/** One GitHub REST request, answered as it came: for callers that read the status or stream the body. */
export function fetchGitHub(path: string, token: string, init: GitHubRequestInit = {}): Promise<Response> {
  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'CloudChef',
    'X-GitHub-Api-Version': API_VERSION,
  });
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${API}${path}`, { method: init.method ?? 'GET', headers, body: init.body });
}

/** One GitHub REST request whose successful JSON answer is parsed with `schema`. */
export async function callGitHub<T>(
  path: string,
  token: string,
  schema: z.ZodType<T>,
  init: GitHubRequestInit = {},
): Promise<T> {
  return parseGitHubResponse(await fetchGitHub(path, token, init), schema);
}

/** As `callGitHub`, answering null for what GitHub doesn't have (404). */
export async function callGitHubOrNull<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T | null> {
  const response = await fetchGitHub(path, token);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  return parseGitHubResponse(response, schema);
}

/** Runs GitHub calls, answering GitHub's refusal with `failure`'s response; any other error still throws. */
export async function withGitHubFailure<T>(
  call: () => Promise<T>,
  failure: (error: GitHubError) => Response,
): Promise<T | Response> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GitHubError) {
      return failure(error);
    }
    throw error;
  }
}

async function parseGitHubResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel();
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
    throw new GitHubError(`GitHub refused the request (${response.status}).`, response.status, rateLimited);
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new GitHubError('GitHub returned an unexpected response.', 502);
  }
  return parsed.data;
}
