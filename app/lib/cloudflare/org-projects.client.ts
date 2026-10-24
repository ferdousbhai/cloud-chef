import { z } from 'zod';
import { executeDataOperation } from './client';
import { api } from './data-api';
import { getJson } from '~/lib/json-request';
import { leavePage } from '~/lib/hooks/useUnsavedEditsGuard';

export const projectRoleSchema = z.enum(['view', 'edit']);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

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
      lastCommitAt: z.iso.datetime().nullish(),
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
