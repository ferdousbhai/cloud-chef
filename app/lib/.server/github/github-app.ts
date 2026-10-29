import { z } from 'zod';
import { createGitHubAppJwt } from './app-jwt';
import { callGitHub, callGitHubOrNull, fetchGitHub, GitHubError, type GitHubRequestInit } from './github-api';

const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

/** The permissions CloudChef asks for when it mints a token: never more than one operation needs. */
type GitHubTokenPermissions = {
  metadata?: 'read';
  contents?: 'read';
};

const accountSchema = z.looseObject({ login: z.string(), type: z.enum(['User', 'Organization']) });
const installationSchema = z.looseObject({
  id: z.number().int(),
  account: accountSchema,
  /** `all` when it reaches every repository of its account, `selected` when only those chosen. */
  repository_selection: z.string().optional(),
});
const tokenSchema = z.looseObject({ token: z.string().min(1), expires_at: z.string() });
const userTokenSchema = z.looseObject({ access_token: z.string().min(1).optional(), error: z.string().optional() });
const gitHubRepositorySchema = z.looseObject({
  id: z.number().int(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
});
const repositoriesPageSchema = z.looseObject({
  total_count: z.number().int(),
  repositories: z.array(gitHubRepositorySchema),
});

type GitHubInstallation = z.infer<typeof installationSchema>;
type GitHubRepository = z.infer<typeof gitHubRepositorySchema>;

type GitHubAppConfig = {
  clientId: string;
  clientSecret: string;
  privateKey: string;
  slug: string;
};

/**
 * CloudChef's GitHub App, for importing repositories. It never stores a token: an import mints an
 * installation token limited to the one repository, read-only, which expires within the hour.
 */
export class GitHubApp {
  constructor(private readonly config: GitHubAppConfig) {}

  /** Where an admin installs the App, choosing the account and repositories it may reach. */
  installUrl(): string {
    return `https://github.com/apps/${encodeURIComponent(this.config.slug)}/installations/new`;
  }

  /**
   * Where a person authorizes the App as themselves (GitHub user authorization), returning to `redirectUri` with a
   * code for who they are and `state`: how CloudChef learns who controls an account that already has the App.
   */
  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL(OAUTH_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** The login of the GitHub user behind `userToken`. */
  async userLogin(userToken: string): Promise<string> {
    return (await this.call('/user', userToken, z.looseObject({ login: z.string() }))).login;
  }

  /** Whether the GitHub user behind `userToken` is an active owner of the GitHub organization `org`. */
  async isOrganizationOwner(userToken: string, org: string): Promise<boolean> {
    const response = await fetchGitHub(`/user/memberships/orgs/${encodeURIComponent(org)}`, userToken);
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const membership = z.looseObject({ role: z.string(), state: z.string() }).safeParse(await response.json());
    return membership.success && membership.data.role === 'admin' && membership.data.state === 'active';
  }

  /** Exchanges the code GitHub returns after installing (user authorization during installation). */
  async userToken(code: string): Promise<string> {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
      }),
    });
    const parsed = userTokenSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success || !parsed.data.access_token) {
      throw new GitHubError('GitHub did not accept the authorization. Start again.', 400);
    }
    return parsed.data.access_token;
  }

  /**
   * One of the App's installations, as the App sees it (the account it is on), or null when the App has
   * none by that id or it is on an account that is neither a user nor an organization. Asked of the App, in
   * one request, rather than found among the installations an admin can see (`/user/installations`, paged):
   * seeing one proves nothing, and whether they control its account is checked on its own.
   */
  async installation(installationId: number): Promise<GitHubInstallation | null> {
    const jwt = await createGitHubAppJwt(this.config.clientId, this.config.privateKey);
    return callGitHubOrNull(`/app/installations/${installationId}`, jwt, installationSchema.nullable().catch(null));
  }

  /** A token for `installationId`, limited to `repositoryIds` (all it reaches when empty) and `permissions`. */
  async installationToken(
    installationId: number,
    permissions: GitHubTokenPermissions,
    repositoryIds: number[] = [],
  ): Promise<string> {
    const jwt = await createGitHubAppJwt(this.config.clientId, this.config.privateKey);
    const body = repositoryIds.length > 0 ? { permissions, repository_ids: repositoryIds } : { permissions };
    const minted = await this.call(`/app/installations/${installationId}/access_tokens`, jwt, tokenSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return minted.token;
  }

  /** The repositories an installation reaches, up to the first 500. */
  async installationRepositories(installationId: number): Promise<GitHubRepository[]> {
    const token = await this.installationToken(installationId, { metadata: 'read' });
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await this.call(
        `/installation/repositories?per_page=100&page=${page}`,
        token,
        repositoriesPageSchema,
      );
      repositories.push(...result.repositories);
      if (repositories.length >= result.total_count || result.repositories.length < 100) {
        break;
      }
    }
    return repositories;
  }

  private call<T>(path: string, token: string, schema: z.ZodType<T>, init: GitHubRequestInit = {}): Promise<T> {
    return callGitHub(path, token, schema, init);
  }
}

/** The App this deployment is configured with, or null: GitHub features then report themselves unavailable. */
export function gitHubAppFromEnv(env: Env): GitHubApp | null {
  if (
    !env.GITHUB_APP_CLIENT_ID ||
    !env.GITHUB_APP_CLIENT_SECRET ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_APP_SLUG
  ) {
    return null;
  }
  return new GitHubApp({
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    slug: env.GITHUB_APP_SLUG,
  });
}
