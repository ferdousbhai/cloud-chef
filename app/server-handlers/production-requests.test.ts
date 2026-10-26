import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ORG, ORIGIN, teamFixture, type Body } from '~/test/project-fixture';
import { updateMember } from '~/lib/cloudflare/data/organizations.server';
import { approveProductionRequestAction, declineProductionRequestAction, listMyProjectsAction } from './projects';
import { listOrganizationsAction } from './organizations';
import { runtimeRequestProductionAction } from './runtime-projects';

const COMMIT = 'c'.repeat(40);
const DRAFT = {
  draftId: 'recipe-chat',
  draftRevision: 'rev-1',
  title: 'Recipe box',
  repo: 'p-recipe-chat',
  commit: COMMIT,
};

async function setup() {
  const fixture = await teamFixture();
  const send = async (body: Body, as?: Parameters<typeof fixture.runtime>[2]) =>
    runtimeRequestProductionAction({
      request: await fixture.runtime('/api/cloudflare/runtime-projects/request-production', body, as),
      env: fixture.env,
    });
  const approve = (cookie: string, requestId: string) =>
    approveProductionRequestAction({
      request: fixture.browser(cookie, '/api/organizations/production-requests/approve', { orgId: ORG, requestId }),
      env: fixture.env,
    });
  const decline = (cookie: string, requestId: string, note = '') =>
    declineProductionRequestAction({
      request: fixture.browser(cookie, '/api/organizations/production-requests/decline', {
        orgId: ORG,
        requestId,
        note,
      }),
      env: fixture.env,
    });
  return { ...fixture, send, approve, decline };
}

const sentSchema = z.object({ requestId: z.string(), outcome: z.string() });

describe('production requests', () => {
  it("records a member's draft by its own repository and commit, and replaces it when sent again", async () => {
    const { database, send } = await setup();
    const first = await send({ ...DRAFT, note: 'For the family', previewUrl: 'https://draft.sara.workers.dev' });
    expect(first.status).toBe(201);
    const { requestId } = sentSchema.parse(await first.json());
    expect(sentSchema.parse(await (await send({ ...DRAFT, note: 'For the family' })).json()).outcome).toBe('unchanged');
    const newer = await send({ ...DRAFT, draftRevision: 'rev-2', commit: 'd'.repeat(40) });
    expect(sentSchema.parse(await newer.json())).toEqual({ requestId, outcome: 'updated' });
    expect(
      database
        .prepare('SELECT repo, commit_sha, draft_revision, snapshot_files, status FROM production_requests')
        .all(),
    ).toEqual([
      {
        repo: 'p-recipe-chat',
        commit_sha: 'd'.repeat(40),
        draft_revision: 'rev-2',
        snapshot_files: 0,
        status: 'pending',
      },
    ]);
  });

  it('refuses a request that names no draft repository, comes from a personal account, or from a member without drafts', async () => {
    const { database, send, sara } = await setup();
    expect((await send({ ...DRAFT, repo: 't-imported' })).status).toBe(400);
    expect((await send({ ...DRAFT, commit: 'main' })).status).toBe(400);
    expect((await send({ ...DRAFT, previewUrl: 'https://evil.example.com' })).status).toBe(400);
    expect((await send(DRAFT, { connection: 'own' })).status).toBe(409);
    database.prepare('UPDATE organization_members SET drafts_allowed = 0 WHERE user_id = ?').run(sara.userId);
    const refused = await send(DRAFT);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'drafts_not_allowed' });
  });

  it('keeps one name per waiting draft, and at most five waiting', async () => {
    const { send } = await setup();
    expect((await send(DRAFT)).status).toBe(201);
    expect((await send({ ...DRAFT, draftId: 'another', repo: 'p-another' })).status).toBe(409);
    for (let index = 0; index < 4; index += 1) {
      expect((await send({ ...DRAFT, draftId: `d${index}`, repo: `p-d${index}`, title: `App ${index}` })).status).toBe(
        201,
      );
    }
    expect((await send({ ...DRAFT, draftId: 'sixth', repo: 'p-sixth', title: 'Sixth' })).status).toBe(429);
  });

  it('approves a draft by adopting its own repository as a team project its requester may edit, in one step', async () => {
    const { database, env, send, approve, admin, sara } = await setup();
    const { requestId } = sentSchema.parse(
      await (await send({ ...DRAFT, note: 'For the family', previewUrl: 'https://draft.sara.workers.dev' })).json(),
    );
    expect((await approve(sara.cookie, requestId)).status).toBe(403);
    const approved = await approve(admin.cookie, requestId);
    expect(approved.status).toBe(200);
    const body = z
      .object({
        projectId: z.string(),
        repo: z.string(),
        workersBuilds: z.object({ namespace: z.string(), repo: z.string(), connectUrl: z.string() }),
      })
      .parse(await approved.json());
    expect(body).toMatchObject({
      repo: 'p-recipe-chat',
      workersBuilds: { namespace: 'cloudchef', repo: 'p-recipe-chat' },
    });
    expect(
      database
        .prepare(
          'SELECT id, connection_id, org_id, name, created_from, artifact_repo, import_repo_full_name FROM org_projects',
        )
        .all(),
    ).toEqual([
      {
        id: body.projectId,
        connection_id: 'team-connection',
        org_id: ORG,
        name: 'Recipe box',
        created_from: 'draft',
        artifact_repo: 'p-recipe-chat',
        import_repo_full_name: null,
      },
    ]);
    expect(database.prepare('SELECT user_id, role FROM org_project_access').all()).toEqual([
      { user_id: sara.userId, role: 'edit' },
    ]);
    expect(database.prepare('SELECT status, note, preview_url, project_id FROM production_requests').get()).toEqual({
      status: 'approved',
      note: null,
      preview_url: null,
      project_id: body.projectId,
    });
    expect((await approve(admin.cookie, requestId)).status).toBe(409);

    // Sara sees it decided, and the project among hers.
    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: sara.cookie } }),
      env,
    });
    const view = z
      .object({ organizations: z.array(z.object({ ownRequests: z.array(z.object({ status: z.string() })) })) })
      .parse(await listed.json());
    expect(view.organizations[0].ownRequests).toEqual([expect.objectContaining({ status: 'approved' })]);
    database.prepare("UPDATE cloudflare_auth_sessions SET context_connection_id = 'team-connection'").run();
    const mine = await listMyProjectsAction({
      request: new Request(`${ORIGIN}/api/org-projects`, { headers: { cookie: sara.cookie } }),
      env,
    });
    expect(await mine.json()).toEqual({
      projects: [
        {
          id: body.projectId,
          name: 'Recipe box',
          repo: 'p-recipe-chat',
          role: 'edit',
          importRepoFullName: null,
          siteUrl: null,
          siteFrameable: null,
        },
      ],
    });
  });

  it('approves a draft sent again after its approval into the project it already is', async () => {
    const { database, send, approve, admin } = await setup();
    const first = sentSchema.parse(await (await send(DRAFT)).json());
    const { projectId } = z
      .object({ projectId: z.string() })
      .parse(await (await approve(admin.cookie, first.requestId)).json());
    const again = sentSchema.parse(await (await send({ ...DRAFT, draftRevision: 'rev-2' })).json());
    expect(again.requestId).not.toBe(first.requestId);
    const approved = z
      .object({ projectId: z.string() })
      .parse(await (await approve(admin.cookie, again.requestId)).json());
    expect(approved.projectId).toBe(projectId);
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_projects').get()).toEqual({ n: 1 });
  });

  it('lets only an admin decline, once, and declines the requests of someone who leaves', async () => {
    const { database, env, send, approve, decline, admin, sara } = await setup();
    const { requestId } = sentSchema.parse(await (await send(DRAFT)).json());
    expect((await decline(sara.cookie, requestId)).status).toBe(403);
    expect((await decline(admin.cookie, requestId, 'Not now')).status).toBe(204);
    expect((await decline(admin.cookie, requestId)).status).toBe(409);
    expect((await approve(admin.cookie, requestId)).status).toBe(409);
    expect(database.prepare('SELECT status, decision_note FROM production_requests').get()).toEqual({
      status: 'declined',
      decision_note: 'Not now',
    });

    const waiting = sentSchema.parse(
      await (await send({ ...DRAFT, draftId: 'other', repo: 'p-other', title: 'Other' })).json(),
    );
    await updateMember(env.DB, { orgId: ORG, actorId: admin.userId, userId: sara.userId, action: 'remove' });
    expect((await approve(admin.cookie, waiting.requestId)).status).toBe(409);
    expect(
      database.prepare('SELECT status, decision_note FROM production_requests WHERE id = ?').get(waiting.requestId),
    ).toEqual({ status: 'declined', decision_note: 'They were removed from the team.' });
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_projects').get()).toEqual({ n: 0 });
  });
});
