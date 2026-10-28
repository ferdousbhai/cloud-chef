import { z } from 'zod';
import { executeDataOperation } from './client';
import { api } from './data-api';
import { getJson, postJson } from '~/lib/json-request';
import { leavePage } from '~/lib/hooks/useUnsavedEditsGuard';

export const projectRoleSchema = z.enum(['view', 'edit']);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

const deploymentSchema = z.object({
  id: z.string(),
  state: z.enum(['queued', 'building', 'deploying', 'succeeded', 'failed', 'superseded', 'not_deployable']),
  failureStage: z.enum(['config', 'install', 'build', 'migrations', 'deploy', 'interrupted']).nullish(),
  /** CloudChef's own short sentence on why it failed or can't be published. */
  reason: z.string().nullish(),
  /** The Worker it went to, and the one its config names when that one was taken and it went to another. */
  workerName: z.string().nullish(),
  wantedWorkerName: z.string().nullish(),
  /** What a running publish is doing now, and since when. */
  step: z.enum(['preparing', 'installing', 'building', 'migrating', 'publishing']).nullish(),
  stepStartedAt: z.number().nullish(),
  updatedAt: z.number(),
});

export type ProjectDeployment = z.infer<typeof deploymentSchema>;
export type ProjectDeploymentState = ProjectDeployment['state'];

const projectVisibilitySchema = z.enum(['private', 'public']);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

const teamProjectsSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: projectRoleSchema,
      /** The project's Artifacts repository; null until the first person to open it has imported it. */
      repo: z.string().nullable(),
      /** The live site's address, when Workers Builds has deployed it. */
      siteUrl: z.url({ protocol: /^https$/ }).nullish(),
      /** Whether the site lets CloudChef show it in a frame; unknown until checked. */
      siteFrameable: z.boolean().nullish(),
      /** When it was added to CloudChef. */
      createdAt: z.iso.datetime().nullish(),
      /** Who builds and publishes it: Workers Builds (imported from GitHub), or CloudChef itself (uploaded). */
      deploysWith: z.enum(['workers_builds', 'cloudchef']).nullish(),
      /** For a project CloudChef publishes, its newest publish of main, however it went; null before the first. */
      deployment: deploymentSchema.nullish(),
      /** Its address on CloudChef, `owner/slug`. */
      fullName: z.string().nullish(),
      /** Whether anyone signed in to CloudChef can find it in Explore, open its site, read its code and copy it. */
      visibility: projectVisibilitySchema.nullish(),
      /** Whether this person may make it public or private: a personal project's owner, or a team admin. */
      canManage: z.boolean().nullish(),
    }),
  ),
});

export type TeamProject = z.infer<typeof teamProjectsSchema>['projects'][number];

/** The team projects this person may view or edit in the team they are working in now. */
export async function loadTeamProjects(signal?: AbortSignal): Promise<TeamProject[]> {
  return (await getJson('/api/org-projects', teamProjectsSchema, undefined, signal)).projects;
}

/**
 * Opens a team project's workspace, in the project's chat (made the first time it's opened). Returns false
 * when the person chose to stay for edits not yet saved.
 */
export function openTeamProject(project: Pick<TeamProject, 'id'>, onNavigate?: () => void) {
  return leavePage(async () => {
    const { initialId } = await executeDataOperation(api.messages.openLinkedChat, {
      id: crypto.randomUUID(),
      orgProjectId: project.id,
    });
    onNavigate?.();
    window.location.assign(`/chat/${encodeURIComponent(initialId)}`);
  });
}

/** Makes a project public or private; refused for someone who may not manage it. */
export async function setProjectVisibility(
  projectId: string,
  visibility: ProjectVisibility,
): Promise<ProjectVisibility> {
  const schema = z.object({ visibility: projectVisibilitySchema });
  return (await postJson('/api/projects/visibility', { projectId, visibility }, schema)).visibility;
}

const appsSchema = z.object({
  apps: z.array(
    z.object({
      /** The app's id, which is its chat's. */
      id: z.string(),
      /** Its address on CloudChef, `owner/slug`. */
      fullName: z.string().nullable(),
      visibility: projectVisibilitySchema,
    }),
  ),
});

export type App = z.infer<typeof appsSchema>['apps'][number];

/**
 * The person's apps (projects made in a chat) in the account they are working in now. One just made isn't
 * listed until CloudChef has recorded it.
 */
export async function loadApps(signal?: AbortSignal): Promise<App[]> {
  return (await getJson('/api/apps', appsSchema, undefined, signal)).apps;
}

const exploreSchema = z.object({
  projects: z.array(
    z.object({
      /** A project, or an app made in a chat; either is copied the same way. */
      kind: z.enum(['project', 'app']),
      id: z.string(),
      name: z.string(),
      fullName: z.string().nullable(),
      owner: z.object({ username: z.string().nullable(), name: z.string() }),
      siteUrl: z.url({ protocol: /^https$/ }).nullable(),
      siteFrameable: z.boolean().nullable(),
      createdAt: z.iso.datetime(),
      /** The public project this one was copied from, when it was. */
      copiedFrom: z.object({ fullName: z.string().nullable() }).nullable(),
    }),
  ),
});

export type PublicProject = z.infer<typeof exploreSchema>['projects'][number];

/** Every public project, newest first. */
export async function loadPublicProjects(signal?: AbortSignal): Promise<PublicProject[]> {
  return (await getJson('/api/explore', exploreSchema, 'Public projects could not be loaded. Try again.', signal))
    .projects;
}

const copySchema = z.object({ projectId: z.string(), initialId: z.string(), fullName: z.string().nullable() });

/**
 * Copies a project, with its whole history, into the account the person is working in now. The copy is
 * published like an uploaded project; `initialId` is its chat.
 */
export async function copyProject(projectId: string, name?: string): Promise<z.infer<typeof copySchema>> {
  return postJson('/api/projects/copy', { projectId, name }, copySchema, 'The copy could not be made. Try again.');
}

const deletionResourceSchema = z.object({
  kind: z.enum(['database', 'storage', 'keys', 'other']),
  id: z.string(),
  name: z.string(),
});
const deletionPreviewSchema = z.object({
  sites: z.array(z.string()),
  workers: z.array(z.string()),
  resources: z.array(deletionResourceSchema),
  kept: z.array(deletionResourceSchema.extend({ reason: z.string() })),
  repository: z.string().nullable(),
});
export type ProjectDeletionPreview = z.infer<typeof deletionPreviewSchema>;

/** What deleting a project would remove from its Cloudflare account, and what it would keep. */
export async function loadDeletionPreview(projectId: string): Promise<ProjectDeletionPreview> {
  return postJson(
    '/api/projects/delete/preview',
    { projectId },
    deletionPreviewSchema,
    'What it would delete couldn’t be read. Try again.',
  );
}

/** Deletes a project for good: its Workers, the resources only they used, its code and its record. */
export async function deleteProject(projectId: string, confirm: string): Promise<void> {
  await postJson(
    '/api/projects/delete',
    { projectId, confirm },
    z.object({ deleted: z.array(z.string()) }),
    'The project couldn’t be deleted. Try again.',
  );
}
