import { z } from 'zod';
import { createGitHubAppJwt } from './app-jwt';
import { callGitHub, fetchGitHub, GitHubError, type GitHubRequestInit } from './github-api';
import { RepositoryClient } from './repository-client';

const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** The permissions CloudChef asks for when it mints a token: never more than one operation needs. */
type GitHubTokenPermissions = {
  metadata?: 'read';
  contents?: 'read' | 'write';
  checks?: 'read';
};

const accountSchema = z.looseObject({ login: z.string(), type: z.enum(['User', 'Organization']) });
const installationSchema = z.looseObject({ id: z.number().int(), account: accountSchema });
const userInstallationsSchema = z.looseObject({ installations: z.array(installationSchema) });
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
 * CloudChef's GitHub App. It never stores a token: every operation mints an installation token scoped
 * to the one repository and the permissions it needs, which expires within the hour.
 */
export class GitHubApp {
  constructor(
    private readonly config: GitHubAppConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Where an admin installs the App, choosing the account and repositories it may reach. */
  installUrl(): string {
    return `https://github.com/apps/${encodeURIComponent(this.config.slug)}/installations/new`;
  }

  /** Where an admin authorizes CloudChef to act as them on GitHub once (to create a repository). */
  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** The login of the GitHub user behind `userToken`. */
  async userLogin(userToken: string): Promise<string> {
    return (await this.call('/user', userToken, z.looseObject({ login: z.string() }))).login;
  }

  /**
   * Creates a repository as the GitHub user behind `userToken`: in the organization `owner` when it is
   * one, else in their own account. It starts with a README, so its default branch exists.
   */
  async createRepository(
    userToken: string,
    args: { owner: string | null; name: string; private: boolean; description: string },
  ): Promise<GitHubRepository> {
    return this.call(
      args.owner ? `/orgs/${encodeURIComponent(args.owner)}/repos` : '/user/repos',
      userToken,
      gitHubRepositorySchema,
      {
        method: 'POST',
        body: JSON.stringify({
          name: args.name,
          private: args.private,
          description: args.description,
          auto_init: true,
        }),
      },
    );
  }

  /** Whether the GitHub user behind `userToken` is an active owner of the GitHub organization `org`. */
  async isOrganizationOwner(userToken: string, org: string): Promise<boolean> {
    const response = await fetchGitHub(this.request, `/user/memberships/orgs/${encodeURIComponent(org)}`, userToken);
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const membership = z.looseObject({ role: z.string(), state: z.string() }).safeParse(await response.json());
    return membership.success && membership.data.role === 'admin' && membership.data.state === 'active';
  }

  /** A repository the GitHub user behind `userToken` can see, by `owner/name`, or null. */
  async findRepository(userToken: string, fullName: string): Promise<GitHubRepository | null> {
    const response = await fetchGitHub(this.request, `/repos/${fullName}`, userToken);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return gitHubRepositorySchema.parse(await response.json());
  }

  /**
   * Adds a repository to an installation limited to selected repositories. An installation covering all
   * of the account's repositories already includes it, and GitHub refuses the call then: not an error.
   */
  async addRepositoryToInstallation(userToken: string, installationId: number, repositoryId: number): Promise<void> {
    const request = this.request;
    await fetchGitHub(request, `/user/installations/${installationId}/repositories/${repositoryId}`, userToken, {
      method: 'PUT',
    }).then((response) => response.body?.cancel());
  }

  /** Exchanges the code GitHub returns after installing (user authorization during installation). */
  async userToken(code: string): Promise<string> {
    const request = this.request;
    const response = await request(OAUTH_TOKEN_URL, {
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

  /** The installations the GitHub user behind `userToken` can reach: proof an installation is theirs. */
  async userInstallations(userToken: string): Promise<GitHubInstallation[]> {
    const page = await this.call(`/user/installations?per_page=100`, userToken, userInstallationsSchema);
    return page.installations;
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

  /** A client for one repository, holding a token limited to it and `permissions`. */
  async repository(
    installationId: number,
    repository: { id: number; fullName: string },
    permissions: GitHubTokenPermissions,
  ): Promise<RepositoryClient> {
    const token = await this.installationToken(installationId, permissions, [repository.id]);
    return new RepositoryClient(token, repository.fullName, this.request);
  }

  private call<T>(path: string, token: string, schema: z.ZodType<T>, init: GitHubRequestInit = {}): Promise<T> {
    return callGitHub(this.request, path, token, schema, init);
  }
}

/** The App this deployment is configured with, or null: GitHub features then report themselves unavailable. */
export function gitHubAppFromEnv(env: Env, request: typeof fetch = fetch): GitHubApp | null {
  if (
    !env.GITHUB_APP_CLIENT_ID ||
    !env.GITHUB_APP_CLIENT_SECRET ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_APP_SLUG
  ) {
    return null;
  }
  return new GitHubApp(
    {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      slug: env.GITHUB_APP_SLUG,
    },
    request,
  );
}
