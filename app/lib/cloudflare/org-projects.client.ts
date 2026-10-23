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
 * Opens a team project's workspace: its current conversation, or a new one when `fresh`, which archives the
 * current one. Returns false when the person chose to stay for edits not yet saved.
 */
export function openTeamProject(project: Pick<TeamProject, 'id'>, fresh: boolean, onNavigate?: () => void) {
  // A new conversation archives the current one, so staying for edits not yet saved must come first.
  return leavePage(async () => {
    const args = { id: crypto.randomUUID(), orgProjectId: project.id };
    const { initialId } = fresh
      ? await executeDataOperation(api.messages.startLinkedChat, args)
      : await executeDataOperation(api.messages.openLinkedChat, args);
    onNavigate?.();
    window.location.assign(`/chat/${encodeURIComponent(initialId)}`);
  });
}
