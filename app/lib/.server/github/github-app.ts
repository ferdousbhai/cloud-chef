import { z } from 'zod';
import { createGitHubAppJwt } from './app-jwt';

const API = 'https://api.github.com';
const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_VERSION = '2022-11-28';

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

/** A GitHub request that failed: `status` is GitHub's, or 502 for a response CloudChef couldn't read. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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

  private async call<T>(
    path: string,
    token: string,
    schema: z.ZodType<T>,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'CloudChef',
      'X-GitHub-Api-Version': API_VERSION,
    });
    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const request = this.request;
    const response = await request(`${API}${path}`, { method: init.method ?? 'GET', headers, body: init.body });
    if (!response.ok) {
      throw new GitHubError(`GitHub refused the request (${response.status}).`, response.status);
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new GitHubError('GitHub returned an unexpected response.', 502);
    }
    return parsed.data;
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
