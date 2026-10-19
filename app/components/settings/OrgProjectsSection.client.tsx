import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { createCloudflareReturnURL, ReauthenticationRequiredError } from '~/lib/auth-client';
import { getJson, noContentSchema, postJson, run } from './organization-requests.client';

export const orgGitHubSchema = z.object({ accountLogin: z.string(), accountType: z.string() }).nullable();
export const orgProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoFullName: z.string(),
  defaultBranch: z.string(),
  origin: z.enum(['linked', 'promoted']),
  memberIds: z.array(z.string()),
});
export const productionRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  previewUrl: z.string().nullable(),
  files: z.number(),
  requesterName: z.string(),
  requesterEmail: z.string(),
});
export const ownRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'approved', 'declined']),
  decisionNote: z.string().nullable(),
});

type ProductionRequest = z.infer<typeof productionRequestSchema>;
const approvalStartedSchema = z.object({ authorizeUrl: z.string() });

/** Where an admin connects a promoted app's repository to Workers Builds, which then deploys it. */
const WORKERS_BUILDS_IMPORT_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages/create';

type OrgProject = z.infer<typeof orgProjectSchema>;
type ProjectMember = { userId: string; name: string; email: string; role: 'admin' | 'member' };

const installStartedSchema = z.object({ installUrl: z.string() });
const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({ id: z.number(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean() }),
  ),
});
const linkedSchema = z.object({ projectId: z.string() });

type Repository = z.infer<typeof repositoriesSchema>['repositories'][number];

/**
 * An admin's view of an organization's GitHub projects: the GitHub account CloudChef's App is installed
 * on, the repositories linked as projects, and which members may work on each. Admins work on all of them.
 */
export function OrgProjectsSection({
  orgId,
  github,
  projects,
  members,
  productionRequests,
  onChanged,
  onMessage,
  onSignInRequired,
}: {
  orgId: string;
  github: z.infer<typeof orgGitHubSchema>;
  projects: OrgProject[];
  members: ProjectMember[];
  productionRequests: ProductionRequest[];
  onChanged: () => void;
  onMessage: (message: string | null) => void;
  onSignInRequired: (reason: string) => void;
}) {
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [repoId, setRepoId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const linkedIds = new Set(projects.map((project) => project.repoFullName));
  const contributors = members.filter((member) => member.role === 'member');

  const connect = () =>
    void run(
      async () => {
        try {
          const { installUrl } = await postJson(
            '/api/organizations/github/start',
            { orgId, callbackURL: createCloudflareReturnURL(window.location.href) },
            installStartedSchema,
          );
          window.location.assign(installUrl);
        } catch (failure) {
          if (!(failure instanceof ReauthenticationRequiredError)) {
            throw failure;
          }
          onSignInRequired(failure.message);
        }
      },
      () => undefined,
      onMessage,
    );

  const chooseRepository = () =>
    void run(
      async () => {
        const listed = await getJson(
          `/api/organizations/github/repositories?orgId=${encodeURIComponent(orgId)}`,
          repositoriesSchema,
        );
        setRepositories(listed.repositories);
      },
      () => undefined,
      onMessage,
    );

  const link = async (event: FormEvent) => {
    event.preventDefault();
    const repository = repositories?.find((candidate) => String(candidate.id) === repoId);
    if (!repository) {
      return;
    }
    setBusy(true);
    await run(
      async () => {
        await postJson(
          '/api/organizations/projects/link',
          { orgId, repoId: repository.id, name: name.trim() || repository.fullName.split('/')[1] },
          linkedSchema,
        );
      },
      () => {
        setRepositories(null);
        setRepoId('');
        setName('');
        onChanged();
      },
      onMessage,
    );
    setBusy(false);
  };

  return (
    <div className="mt-3 grid gap-2 text-sm">
      <h4 className="font-medium">Projects</h4>
      {github === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-content-secondary">
            Connect GitHub to let people work on repositories here; each one deploys through its own pipeline.
          </span>
          <Button size="xs" variant="neutral" onClick={connect}>
            Connect GitHub
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-content-secondary">
            Repositories from github.com/{github.accountLogin}
          </span>
          <Button size="xs" variant="subtle" onClick={connect}>
            Change repositories
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() =>
              void run(
                async () => {
                  await postJson('/api/organizations/github/disconnect', { orgId }, noContentSchema);
                },
                onChanged,
                onMessage,
              )
            }
          >
            Disconnect
          </Button>
        </div>
      )}
      {productionRequests.length > 0 ? (
        <ul className="grid gap-2" aria-label="Production requests">
          {productionRequests.map((pending) => (
            <ProductionRequestRow
              key={pending.id}
              orgId={orgId}
              pending={pending}
              githubConnected={github !== null}
              onChanged={onChanged}
              onMessage={onMessage}
              onSignInRequired={onSignInRequired}
            />
          ))}
        </ul>
      ) : null}
      <ul className="grid gap-2">
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            orgId={orgId}
            project={project}
            contributors={contributors}
            onChanged={onChanged}
            onMessage={onMessage}
          />
        ))}
      </ul>
      {github !== null && repositories === null ? (
        <Button className="justify-self-start" size="xs" variant="neutral" onClick={chooseRepository}>
          Link a repository
        </Button>
      ) : null}
      {repositories !== null ? (
        <form className="flex flex-wrap gap-2" onSubmit={(event) => void link(event)}>
          <select
            required
            aria-label="Repository"
            value={repoId}
            onChange={(event) => setRepoId(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 text-sm"
          >
            <option value="">Choose a repository</option>
            {repositories
              .filter((repository) => !linkedIds.has(repository.fullName))
              .map((repository) => (
                <option key={repository.id} value={String(repository.id)}>
                  {repository.fullName}
                </option>
              ))}
          </select>
          <TextInput
            maxLength={80}
            placeholder="Project name"
            aria-label="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="xs" variant="neutral" loading={busy} disabled={!repoId}>
            Link
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setRepositories(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function ProjectRow({
  orgId,
  project,
  contributors,
  onChanged,
  onMessage,
}: {
  orgId: string;
  project: OrgProject;
  contributors: ProjectMember[];
  onChanged: () => void;
  onMessage: (message: string | null) => void;
}) {
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const allowed = new Set(project.memberIds);
  const setAccess = (userId: string, granted: boolean) =>
    void run(
      async () => {
        await postJson(
          '/api/organizations/projects/access',
          { orgId, projectId: project.id, userId, allowed: granted },
          noContentSchema,
        );
      },
      onChanged,
      onMessage,
    );
  return (
    <li className="grid gap-1 rounded-md border border-bolt-elements-borderColor p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {project.name}{' '}
          <a
            className="text-content-secondary underline"
            href={`https://github.com/${project.repoFullName}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {project.repoFullName}
          </a>
        </span>
        <Button
          size="xs"
          variant={confirmingUnlink ? 'danger' : 'subtle'}
          onClick={() => {
            if (confirmingUnlink) {
              void run(
                async () => {
                  await postJson(
                    '/api/organizations/projects/unlink',
                    { orgId, projectId: project.id },
                    noContentSchema,
                  );
                },
                onChanged,
                onMessage,
              );
            }
            setConfirmingUnlink(!confirmingUnlink);
          }}
        >
          {confirmingUnlink ? 'Unlink (the repository stays on GitHub)' : 'Unlink'}
        </Button>
      </div>
      {project.origin === 'promoted' ? (
        <p className="text-xs text-content-secondary">
          New from an approved draft. To deploy it, connect the repository in{' '}
          <a className="underline" href={WORKERS_BUILDS_IMPORT_URL} target="_blank" rel="noopener noreferrer">
            Workers Builds
          </a>{' '}
          (Import a repository, deploy command <code>pnpm run deploy</code>), and turn on preview builds.
        </p>
      ) : null}
      {contributors.length > 0 ? (
        <div className="flex flex-wrap gap-3 text-xs text-content-secondary">
          {contributors.map((member) => (
            <label key={member.userId} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={allowed.has(member.userId)}
                onChange={(event) => setAccess(member.userId, event.target.checked)}
              />
              {member.name || member.email}
            </label>
          ))}
        </div>
      ) : (
        <span className="text-xs text-content-tertiary">Invite members to give them this project.</span>
      )}
    </li>
  );
}

/** A member's request to make a draft a real project, as an admin decides it. */
function ProductionRequestRow({
  orgId,
  pending,
  githubConnected,
  onChanged,
  onMessage,
  onSignInRequired,
}: {
  orgId: string;
  pending: ProductionRequest;
  githubConnected: boolean;
  onChanged: () => void;
  onMessage: (message: string | null) => void;
  onSignInRequired: (reason: string) => void;
}) {
  const [repoName, setRepoName] = useState(
    pending.title
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100),
  );
  const [privateRepo, setPrivateRepo] = useState(true);
  const approve = () =>
    void run(
      async () => {
        try {
          const { authorizeUrl } = await postJson(
            '/api/organizations/production-requests/approve',
            { orgId, requestId: pending.id, repoName, private: privateRepo },
            approvalStartedSchema,
          );
          window.location.assign(authorizeUrl);
        } catch (failure) {
          if (!(failure instanceof ReauthenticationRequiredError)) {
            throw failure;
          }
          onSignInRequired(failure.message);
        }
      },
      () => undefined,
      onMessage,
    );
  const decline = () =>
    void run(
      async () => {
        await postJson(
          '/api/organizations/production-requests/decline',
          { orgId, requestId: pending.id, note: '' },
          noContentSchema,
        );
      },
      onChanged,
      onMessage,
    );
  return (
    <li className="grid gap-1 rounded-md border border-bolt-elements-borderColor p-2">
      <span>
        <strong>{pending.title}</strong>{' '}
        <span className="text-content-secondary">
          from {pending.requesterName || pending.requesterEmail} wants to go to production
        </span>
      </span>
      {pending.note ? <span className="text-xs text-content-secondary">{pending.note}</span> : null}
      {pending.previewUrl ? (
        <a className="text-xs underline" href={pending.previewUrl} target="_blank" rel="noopener noreferrer">
          Try the draft
        </a>
      ) : null}
      {githubConnected ? (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            aria-label="Repository name"
            value={repoName}
            onChange={(event) => setRepoName(event.target.value)}
            className="min-w-0 flex-1"
          />
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={privateRepo} onChange={(event) => setPrivateRepo(event.target.checked)} />
            Private
          </label>
          <Button size="xs" variant="primary" disabled={!repoName} onClick={approve}>
            Approve and create repository
          </Button>
          <Button size="xs" variant="subtle" onClick={decline}>
            Decline
          </Button>
        </div>
      ) : (
        <span className="text-xs text-content-tertiary">Connect GitHub to approve it into a repository.</span>
      )}
    </li>
  );
}

/** A member's list of the projects they were given in an organization. */
export function MyOrgProjects({
  projects,
  requests,
}: {
  projects: OrgProject[];
  requests: z.infer<typeof ownRequestSchema>[];
}) {
  return (
    <>
      {projects.length > 0 ? (
        <p className="mt-2 text-sm text-content-secondary">
          Your projects: {projects.map((project) => project.name).join(', ')}
        </p>
      ) : null}
      {requests.length > 0 ? (
        <ul className="mt-2 grid gap-1 text-sm text-content-secondary" aria-label="Your production requests">
          {requests.map((request) => (
            <li key={request.id}>
              {request.title}:{' '}
              {request.status === 'pending'
                ? 'waiting for an admin'
                : request.status === 'approved'
                  ? 'approved, now a project'
                  : `declined${request.decisionNote ? ` (${request.decisionNote})` : ''}`}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
