import { z } from 'zod';
import { getJson, postJson } from '~/lib/json-request';
import { projectRoleSchema, type ProjectRole } from './org-projects.client';

/**
 * Sharing a project as a document is shared: a username or an email address, and Can view or Can edit. Whoever runs
 * the project shares it; someone it is shared with works on it in the project's own Cloudflare account.
 */
const sharingSchema = z.object({
  people: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      username: z.string().nullable(),
      image: z.string().nullable(),
      role: z.enum(['owner', 'view', 'edit']),
    }),
  ),
  invitations: z.array(
    z.object({ id: z.string(), email: z.string(), role: projectRoleSchema, sentAt: z.number(), expiresAt: z.number() }),
  ),
  team: z.boolean(),
  /** What the last share did: an address invited, or a person (by name) given access at once. */
  done: z.union([z.object({ invited: z.string() }), z.object({ shared: z.string() })]).optional(),
});

export type ProjectSharing = z.infer<typeof sharingSchema>;

function sharingPath(projectId: string, rest = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/sharing${rest}`;
}

export function loadSharing(projectId: string): Promise<ProjectSharing> {
  return getJson(sharingPath(projectId), sharingSchema, 'Sharing could not be loaded. Try again.');
}

export function shareProjectWith(projectId: string, to: string, role: ProjectRole): Promise<ProjectSharing> {
  return postJson(sharingPath(projectId, '/add'), { to, role }, sharingSchema, 'It could not be shared. Try again.');
}

export function setPersonRole(projectId: string, userId: string, role: ProjectRole | null): Promise<ProjectSharing> {
  return postJson(sharingPath(projectId, '/person'), { userId, role }, sharingSchema, 'That could not be changed.');
}

export function setInvitationRole(
  projectId: string,
  invitationId: string,
  role: ProjectRole | null,
): Promise<ProjectSharing> {
  return postJson(
    sharingPath(projectId, '/invitation'),
    { invitationId, role },
    sharingSchema,
    'That invitation could not be changed.',
  );
}

export function resendInvitation(projectId: string, invitationId: string): Promise<ProjectSharing> {
  return postJson(
    sharingPath(projectId, '/invitation'),
    { invitationId, resend: true },
    sharingSchema,
    'The invitation could not be sent again.',
  );
}

const sharedWithMeSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      /** The account it is in, which opening it switches to. */
      connectionId: z.string(),
      name: z.string(),
      role: projectRoleSchema,
      ownerName: z.string().nullable(),
      repo: z.string().nullable(),
      siteUrl: z.url({ protocol: /^https$/ }).nullish(),
      siteFrameable: z.boolean().nullish(),
      fullName: z.string().nullish(),
      visibility: z.enum(['private', 'public']).nullish(),
      sharedAt: z.iso.datetime(),
    }),
  ),
});

export type SharedWithMe = z.infer<typeof sharedWithMeSchema>;
export type SharedProject = SharedWithMe['projects'][number];

/** The projects this person was added to in other people's accounts, besides the one they are working in. */
export function loadSharedWithMe(signal?: AbortSignal): Promise<SharedWithMe> {
  return getJson('/api/projects/shared', sharedWithMeSchema, 'Shared projects could not be loaded.', signal);
}

/** What someone may do with a project, in a sentence about them. */
export function roleSentence(name: string, role: ProjectRole): string {
  return role === 'edit'
    ? `${name} can change this project and put changes live.`
    : `${name} can look through this project, its history and its code, but not change it.`;
}
