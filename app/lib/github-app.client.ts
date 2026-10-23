import { z } from 'zod';
import { createCloudflareReturnURL } from '~/lib/auth-client';
import { getJson, postJson } from '~/lib/json-request';

/**
 * CloudChef's GitHub App, as importing a private repository uses it: installing it on a GitHub account, and
 * listing the repositories it can read. Both act for the account the person is working in now (`orgId` for a
 * team, none for their own); these two functions are the only places that name the routes.
 */
const installStartedSchema = z.object({ installUrl: z.string() });
const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({ id: z.number(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean() }),
  ),
});

export type GitHubRepository = z.infer<typeof repositoriesSchema>['repositories'][number];

/** The query that brings a person back from GitHub to the import dialog. */
export const IMPORT_RETURN_PARAM = 'import';
const IMPORT_RETURN_VALUE = 'github';

/** Sends the person to GitHub to install the App, returning to `returnURL` afterwards. */
export async function startGitHubAppInstall(orgId: string | null, returnURL: string): Promise<void> {
  const { installUrl } = await postJson(
    '/api/organizations/github/start',
    { orgId: orgId ?? undefined, callbackURL: createCloudflareReturnURL(returnURL) },
    installStartedSchema,
  );
  window.location.assign(installUrl);
}

/** The repositories the installed App can read; refused when it isn't installed for this account. */
export async function listGitHubRepositories(orgId: string | null, signal?: AbortSignal): Promise<GitHubRepository[]> {
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return (await getJson(`/api/organizations/github/repositories${query}`, repositoriesSchema, undefined, signal))
    .repositories;
}

/** Whether a page was opened on the way back from installing the App, to import a repository. */
export function isImportReturn(search: string): boolean {
  return new URLSearchParams(search).get(IMPORT_RETURN_PARAM) === IMPORT_RETURN_VALUE;
}

/** The URL to come back to from GitHub: this page, with the import dialog open. */
export function importReturnURL(href: string): string {
  const url = new URL(href);
  url.searchParams.set(IMPORT_RETURN_PARAM, IMPORT_RETURN_VALUE);
  return url.toString();
}

/** `owner/name` of a github.com repository address, or null when it isn't one. */
export function gitHubRepositoryName(address: string): string | null {
  const match = address
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}
