import { z } from 'zod';
import { createCloudflareReturnURL } from '~/lib/auth-client';
import { getJson, postJson } from '~/lib/json-request';

/**
 * CloudChef's GitHub App ("CloudChef Import" on GitHub), as importing a private repository uses it: installing it on
 * a GitHub account, connecting the person's own GitHub account that already has it, and listing the repositories it
 * can read. Each acts for the account the person is working in now (`orgId` for a team, none for their own); these
 * functions are the only places that name the routes.
 */
const installStartedSchema = z.object({ installUrl: z.string() });
const reuseStartedSchema = z.object({ authorizeUrl: z.string() });
const repositoriesSchema = z.object({
  unreachable: z.array(z.string()).default([]),
  /** The person's own GitHub account, with the App on it, that they connected elsewhere and not here yet. */
  reusable: z.array(z.object({ installationId: z.number(), accountLogin: z.string() })).default([]),
  repositories: z.array(
    z.object({ id: z.number(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean() }),
  ),
});

export type GitHubRepository = z.infer<typeof repositoriesSchema>['repositories'][number];
export type GitHubAccountToReuse = z.infer<typeof repositoriesSchema>['reusable'][number];

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

/**
 * Sends the person to GitHub to confirm it's them, to connect their own GitHub account, which already has the App,
 * here too; returning to `returnURL` afterwards.
 */
export async function startGitHubAccountReuse(
  orgId: string | null,
  installationId: number,
  returnURL: string,
): Promise<void> {
  const { authorizeUrl } = await postJson(
    '/api/organizations/github/reuse',
    { orgId: orgId ?? undefined, installationId, callbackURL: createCloudflareReturnURL(returnURL) },
    reuseStartedSchema,
  );
  window.location.assign(authorizeUrl);
}

/**
 * The repositories the installed App can read, the GitHub accounts it couldn't list just now, and the person's own
 * GitHub account connected elsewhere that can be connected here too.
 */
export async function listGitHubRepositories(
  orgId: string | null,
  signal?: AbortSignal,
): Promise<z.infer<typeof repositoriesSchema>> {
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return getJson(`/api/organizations/github/repositories${query}`, repositoriesSchema, undefined, signal);
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
