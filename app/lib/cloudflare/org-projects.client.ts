import { z } from 'zod';
import { executeDataOperation } from './client';
import { api } from './data-api';
import { getJson } from '~/lib/json-request';
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
  updatedAt: z.number(),
});

export type ProjectDeployment = z.infer<typeof deploymentSchema>;
export type ProjectDeploymentState = ProjectDeployment['state'];

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
      lastCommitAt: z.iso.datetime().nullish(),
      /** Who builds and publishes it: Workers Builds (imported from GitHub), or CloudChef itself (uploaded). */
      deploysWith: z.enum(['workers_builds', 'cloudchef']).nullish(),
      /** For a project CloudChef publishes, its newest publish of main, however it went; null before the first. */
      deployment: deploymentSchema.nullish(),
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
