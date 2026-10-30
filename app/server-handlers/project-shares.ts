import { z } from 'zod';
import { publicOrigin } from '~/lib/.server/public-origin';
import { hasSameOrigin, readJsonRequest, withinAddressRateLimit } from '~/lib/.server/request-guards';
import { getAuthSession } from '~/lib/.server/auth';
import { listWorkspaceContexts } from '~/lib/cloudflare/data/organization-access.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import { listSharedProjects, requireManagedProject, type Project } from '~/lib/cloudflare/data/org-projects.server';
import { shownName } from '~/lib/shown-name';
import {
  acceptInvitation,
  acceptInvitationsForUser,
  describeInvitation,
  projectSharing,
  ProjectShareError,
  renewInvitation,
  setInvitationRole,
  setPersonRole,
  shareProject,
  PROJECT_INVITATION_TTL_MS,
} from '~/lib/cloudflare/data/project-shares.server';
import { SENDER } from './email-auth';
import { nameForEmail } from './organizations';
import { projectIdOfPath } from './projects';
import { signedIn } from './signed-in';

/**
 * Sharing a project, as a document is shared: whoever runs it (its owner, or one of its team's admins) types a
 * username or an email address and chooses Can view or Can edit. A username shares at once and tells that person; an
 * address is always invited (an email with a link), so the person sharing never learns whether it has an account.
 * Whoever it is shared with works on it from a Cloudflare account of their own; its site and builds stay in the
 * owner's.
 */
export const PROJECT_SHARING_ROUTE = '/api/projects/:projectId/sharing';
export const PROJECT_SHARING_ADD_ROUTE = '/api/projects/:projectId/sharing/add';
export const PROJECT_SHARING_PERSON_ROUTE = '/api/projects/:projectId/sharing/person';
export const PROJECT_SHARING_INVITATION_ROUTE = '/api/projects/:projectId/sharing/invitation';
/** Where an invitation's emailed link opens. */
const INVITATION_PATH = '/shared';

const roleSchema = z.enum(['view', 'edit']);
const addSchema = z.strictObject({
  /** A username (`sara`, `@sara`) or an email address. */
  to: z.string().trim().min(1).max(254),
  role: roleSchema,
});
const personSchema = z.strictObject({ userId: z.string().min(1).max(128), role: roleSchema.nullable() });
const invitationSchema = z.union([
  z.strictObject({ invitationId: z.string().uuid(), role: roleSchema.nullable() }),
  z.strictObject({ invitationId: z.string().uuid(), resend: z.literal(true) }),
]);
const tokenSchema = z.strictObject({ token: z.string().min(32).max(128) });

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** `GET /api/projects/<id>/sharing`: who may use the project and who is invited, for whoever runs it. */
export function projectSharingAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return managing(request, env, async ({ project }) => sharingAnswer(env, project));
}

/**
 * `POST /api/projects/<id>/sharing/add`: shares the project with a username or an email address. The answer says
 * "Invited" for every address, whether or not it has an account, and names a person only when named by username.
 */
export function addProjectShareAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return managing(request, env, async ({ project, session }) => {
    const body = await readJsonRequest(request, addSchema, 'Enter a username or an email address.');
    if ('response' in body) {
      return body.response;
    }
    const to = body.data.to;
    if (to.includes('@') && !to.startsWith('@') && !z.email().safeParse(to).success) {
      return Response.json({ error: 'That email address doesn’t look right.' }, { status: 400 });
    }
    // Each share may send an email CloudChef writes, so they're limited per person, as team invites are.
    const { success } = await env.SIGN_IN_RATE_LIMITER.limit({ key: `share:${session.user.id}` });
    if (!success) {
      return Response.json({ error: 'Too many shares at once. Try again in a minute.' }, { status: 429 });
    }
    const outcome = await shareProject(env.DB, {
      project,
      actorId: session.user.id,
      to,
      role: body.data.role,
    });
    const sharer = session.user.name;
    if (outcome.kind === 'invited') {
      const link = invitationLink(request, outcome.token);
      await sendSharedEmail(env, { to: outcome.email, sharer, project, role: body.data.role, link, invitation: true });
    } else if (outcome.email) {
      await sendSharedEmail(env, {
        to: outcome.email,
        sharer,
        project,
        role: body.data.role,
        link: new URL('/', publicOrigin(request)),
        invitation: false,
      });
    }
    return sharingAnswer(
      env,
      project,
      outcome.kind === 'invited' ? { invited: outcome.email } : { shared: outcome.name },
    );
  });
}

/** `POST /api/projects/<id>/sharing/person`: changes what someone may do with the project, or takes it away. */
export function setProjectPersonAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return managing(request, env, async ({ project, session }) => {
    const body = await readJsonRequest(request, personSchema, 'Choose someone and what they may do.');
    if ('response' in body) {
      return body.response;
    }
    await setPersonRole(env.DB, { project, actorId: session.user.id, ...body.data });
    return sharingAnswer(env, project);
  });
}

/** `POST /api/projects/<id>/sharing/invitation`: changes an invitation's role, cancels it, or sends it again. */
export function setProjectInvitationAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return managing(request, env, async ({ project, session }) => {
    const body = await readJsonRequest(request, invitationSchema, 'Choose an invitation.');
    if ('response' in body) {
      return body.response;
    }
    if ('resend' in body.data) {
      const { success } = await env.SIGN_IN_RATE_LIMITER.limit({ key: `share:${session.user.id}` });
      if (!success) {
        return Response.json({ error: 'Too many emails at once. Try again in a minute.' }, { status: 429 });
      }
      const renewed = await renewInvitation(env.DB, {
        projectId: project.id,
        invitationId: body.data.invitationId,
        actorId: session.user.id,
      });
      await sendSharedEmail(env, {
        to: renewed.email,
        sharer: session.user.name,
        project,
        role: renewed.role,
        link: invitationLink(request, renewed.token),
        invitation: true,
      });
    } else {
      await setInvitationRole(env.DB, { projectId: project.id, ...body.data });
    }
    return sharingAnswer(env, project);
  });
}

/**
 * `GET /api/projects/shared`: the projects others shared with this person, from accounts not theirs, for the projects
 * home's "Shared with you". An invitation to their address, once CloudChef has proven it is theirs, is taken first,
 * so a project shared with their email shows as soon as they look. `canOpen` is whether they have an account of
 * their own to open one in.
 */
export function sharedWithMeAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    await acceptInvitationsForUser(env.DB, session.user.id);
    const shared = await listSharedProjects(env.DB, session.user.id);
    return Response.json(
      {
        canOpen: session.context !== null,
        projects: shared.map((project) => ({
          id: project.id,
          name: project.name,
          role: project.role,
          ownerName: project.ownerName ? shownName(project.ownerName) : null,
          repo: project.repo,
          siteUrl: project.siteUrl,
          siteFrameable: project.siteFrameable,
          fullName: project.fullName,
          visibility: project.visibility,
          sharedAt: new Date(project.sharedAt).toISOString(),
        })),
      },
      { headers: NO_STORE },
    );
  });
}

/**
 * `POST /api/project-invitations/describe`: what an invitation's link is for, so its page can name the project, who
 * shared it, and the address to sign in with. Needs no session: the link is the secret.
 */
export async function describeProjectInvitationAction({ request, env }: { request: Request; env: Env }) {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  if (!(await withinAddressRateLimit(env.SIGN_IN_RATE_LIMITER, request))) {
    return Response.json({ error: 'Too many tries. Try again shortly.' }, { status: 429 });
  }
  const body = await readJsonRequest(request, tokenSchema, 'This invitation link is not valid.');
  if ('response' in body) {
    return body.response;
  }
  const invitation = await describeInvitation(env.DB, body.data.token);
  return invitation
    ? Response.json(invitation, { headers: NO_STORE })
    : Response.json(
        { error: 'This invitation has been used, cancelled or has expired. Ask for a new one.' },
        { status: 410, headers: NO_STORE },
      );
}

/**
 * `POST /api/project-invitations/accept`: the person signed in takes the invitation, which needs the address it was
 * sent to, proven. Answers whether they have a Cloudflare account to open it from yet (`needsCloudflare`).
 */
export async function acceptProjectInvitationAction({ request, env }: { request: Request; env: Env }) {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const body = await readJsonRequest(request, tokenSchema, 'This invitation link is not valid.');
  if ('response' in body) {
    return body.response;
  }
  try {
    const { projectId } = await acceptInvitation(env.DB, { token: body.data.token, userId: session.user.id });
    const contexts = await listWorkspaceContexts(env.DB, session.user.id);
    return Response.json({ projectId, needsCloudflare: contexts.length === 0 }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ProjectShareError) {
      return shareRefusal(error);
    }
    throw error;
  }
}

/** Runs `handler` for whoever runs the project the path names; anyone else is told there's no such project. */
function managing(
  request: Request,
  env: Env,
  handler: (args: {
    project: Project;
    session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>;
  }) => Promise<Response>,
): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const projectId = projectIdOfPath(new URL(request.url).pathname) ?? '';
    let project: Project;
    try {
      project = await requireManagedProject(env.DB, session.user.id, projectId);
    } catch (error) {
      if (error instanceof OrganizationError) {
        return Response.json({ error: 'Only whoever runs this project can share it.' }, { status: 404 });
      }
      throw error;
    }
    try {
      return await handler({ project, session });
    } catch (error) {
      if (error instanceof ProjectShareError) {
        return shareRefusal(error);
      }
      throw error;
    }
  });
}

async function sharingAnswer(
  env: Env,
  project: Project,
  done?: { invited: string } | { shared: string },
): Promise<Response> {
  const sharing = await projectSharing(env.DB, project);
  // A person's own project, or a team's: a team's admins all run it.
  const answer: Awaited<ReturnType<typeof projectSharing>> & {
    team: boolean;
    done?: { invited: string } | { shared: string };
  } = { ...sharing, team: project.orgId !== null };
  if (done) {
    answer.done = done;
  }
  return Response.json(answer, { headers: NO_STORE });
}

function shareRefusal(error: ProjectShareError): Response {
  return Response.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, {
    status: error.status,
    headers: NO_STORE,
  });
}

function invitationLink(request: Request, token: string): URL {
  const link = new URL(INVITATION_PATH, publicOrigin(request));
  link.searchParams.set('token', token);
  return link;
}

/**
 * Emails someone a project shared with them: an invitation's link, which needs signing in with this address, or (to a
 * person named by username) where to find it. In everyday words: what they may do, and what working on it needs.
 * False when it couldn't be sent; the share stands.
 */
async function sendSharedEmail(
  env: Env,
  details: {
    to: string;
    sharer: string;
    project: Pick<Project, 'name'>;
    role: 'view' | 'edit';
    link: URL;
    invitation: boolean;
  },
): Promise<boolean> {
  const sharer = nameForEmail(details.sharer, 'Someone');
  const project = nameForEmail(details.project.name, 'a project');
  const can =
    details.role === 'edit'
      ? 'You can change it and put your changes live on their site.'
      : 'You can look through it, see its history and download it.';
  const text = [
    `${sharer} shared ${project} with you on CloudChef.`,
    can,
    '',
    details.invitation ? `Open it: ${details.link.toString()}` : `It's in your projects: ${details.link.toString()}`,
    '',
    ...(details.invitation
      ? [
          `Sign in with this address (${details.to}). The link works for ${PROJECT_INVITATION_TTL_MS / 86_400_000} days.`,
          'To work on it you need a Cloudflare account of your own: your workspace runs there,',
          `and ${sharer}'s site stays in theirs.`,
        ]
      : []),
  ].join('\n');
  try {
    await env.SIGN_IN_EMAIL.send({
      from: SENDER,
      to: details.to,
      subject: `${sharer} shared ${project} with you`,
      text,
    });
    return true;
  } catch {
    console.error('Unable to send a project share email');
    return false;
  }
}
