import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { teamFixture } from '~/test/project-fixture';
import {
  decideApprovalAction,
  listApprovalsAction,
  runtimeApprovalOutcomeAction,
  runtimeFileApprovalAction,
} from './approvals';

/** A request as an agent hands it over: what `cf <command> --dry-run` prints. */
type FiledRequest = { method: string; url: string; body?: Record<string, boolean> };

const filedSchema = z.object({ approvalId: z.string() });
const listedSchema = z.object({
  admin: z.boolean(),
  waiting: z.array(z.object({ id: z.string(), status: z.string() })),
});

/** The id a filing answered. */
async function filedId(answer: Response): Promise<string> {
  return filedSchema.parse(await answer.json()).approvalId;
}

const DOMAIN_LIST = 'https://api.cloudflare.com/client/v4/accounts/account-team/workers/scripts/garden/subdomain';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The team fixture, with a readable authorization for the team's account and Cloudflare's answers recorded. */
async function world() {
  const team = await teamFixture();
  const env = { ...team.env, CLOUDFLARE_OAUTH_CLIENT_ID: 'client', CLOUDFLARE_OAUTH_CLIENT_SECRET: 'secret' };
  const vault = D1CloudflareCredentialVault.fromEnv(env);
  const handle = await vault.storeOAuthCredential({
    accessToken: 'team-token',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  team.database
    .prepare(`UPDATE cloudflare_authorizations SET credential_handle = ? WHERE account_id = 'account-team'`)
    .run(handle);
  const sent: { method: string; url: string; authorization: string | null; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: await request.text(),
      });
      return Response.json({ success: true, result: { enabled: true } });
    }),
  );

  const file = async (
    request: FiledRequest,
    as: { connection?: 'team' | 'own'; toolCallId?: string; terminal?: boolean } = {},
  ) =>
    runtimeFileApprovalAction({
      request: await team.runtime(
        '/api/cloudflare/runtime-projects/approvals/file',
        as.terminal
          ? { source: 'terminal', requestJson: JSON.stringify(request) }
          : { agentName: 'chat-1', toolCallId: as.toolCallId ?? 'call-1', requestJson: JSON.stringify(request) },
        { connection: as.connection },
      ),
      env,
    });
  const list = async (cookie: string) =>
    listedSchema.parse(
      await listApprovalsAction({
        request: new Request('https://cloudchef.build/api/approvals', { headers: { cookie } }),
        env,
      }).then((answer) => answer.json()),
    );
  const decide = (cookie: string, id: string, decision: 'approve' | 'reject') =>
    decideApprovalAction({ request: team.browser(cookie, '/api/approvals/decide', { id, decision }), env });
  const outcome = async (approvalId: string) =>
    runtimeApprovalOutcomeAction({
      request: await team.runtime('/api/cloudflare/runtime-projects/approvals/outcome', { approvalId }),
      env,
    }).then((answer) => answer.json());
  return { ...team, env, sent, file, list, decide, outcome };
}

const change: FiledRequest = { method: 'POST', url: DOMAIN_LIST, body: { enabled: true } };

describe('a member’s change to the team’s account', () => {
  it('waits for an admin, and is sent exactly as filed, once, when one approves it', async () => {
    const { admin, sara, sent, file, list, decide, outcome } = await world();

    const filed = await file(change);
    expect(filed.status).toBe(201);
    const approvalId = await filedId(filed);
    expect(sent).toEqual([]);

    // Only an admin sees it, and only an admin can approve it.
    expect(await list(sara.cookie)).toMatchObject({ admin: false, waiting: [] });
    expect(await list(admin.cookie)).toMatchObject({ admin: true, waiting: [{ id: approvalId, status: 'pending' }] });
    expect((await decide(sara.cookie, approvalId, 'approve')).status).toBe(409);
    expect(sent).toEqual([]);

    const approved = await decide(admin.cookie, approvalId, 'approve');
    expect(await approved.json()).toMatchObject({ status: 'done', result: 'succeeded' });
    expect(sent).toEqual([
      { method: 'POST', url: DOMAIN_LIST, authorization: 'Bearer team-token', body: JSON.stringify({ enabled: true }) },
    ]);
    expect((await decide(admin.cookie, approvalId, 'approve')).status).toBe(409);
    expect(sent).toHaveLength(1);

    // The member's conversation reads back what happened.
    expect(await outcome(approvalId)).toMatchObject({
      agentName: 'chat-1',
      toolCallId: 'call-1',
      status: 'done',
      result: 'succeeded',
      outcome: { status: 'success' },
    });
  });

  it('sends nothing when an admin rejects it, and says so to the member', async () => {
    const { admin, sent, file, list, decide, outcome } = await world();
    const approvalId = await filedId(await file(change));

    expect((await decide(admin.cookie, approvalId, 'reject')).status).toBe(200);

    expect(sent).toEqual([]);
    expect(await outcome(approvalId)).toMatchObject({ status: 'rejected', outcome: { status: 'denied' } });
    expect((await list(admin.cookie)).waiting).toEqual([]);
    expect((await decide(admin.cookie, approvalId, 'approve')).status).toBe(409);
  });

  it('can’t be approved once it has expired', async () => {
    const { admin, database, sent, file, decide, outcome } = await world();
    const approvalId = await filedId(await file(change));
    database.prepare('UPDATE approval_requests SET expires_at = 1').run();

    expect((await decide(admin.cookie, approvalId, 'approve')).status).toBe(409);
    expect(sent).toEqual([]);
    expect(await outcome(approvalId)).toMatchObject({ status: 'expired' });
  });

  it('files each change a command asks for, and only changes in the team’s own account', async () => {
    const { file, list, admin } = await world();

    const first = await filedId(await file(change));
    // A command can ask for several changes: each is its own request for the admins.
    expect(await filedId(await file(change))).not.toBe(first);

    expect((await file({ method: 'GET', url: DOMAIN_LIST }, { toolCallId: 'call-2' })).status).toBe(400);
    expect(
      (
        await file(
          { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/someone-else/workers/scripts/x' },
          { toolCallId: 'call-3' },
        )
      ).status,
    ).toBe(400);
    // Sara's own account has no team admins to ask.
    expect((await file(change, { connection: 'own', toolCallId: 'call-4' })).status).toBe(403);
    expect((await list(admin.cookie)).waiting).toHaveLength(2);
  });

  it('files a change the member typed in their terminal, which goes back to no conversation', async () => {
    const { admin, database, sent, file, list, decide, outcome } = await world();

    const filed = await file(change, { terminal: true });
    expect(filed.status).toBe(201);
    const approvalId = await filedId(filed);
    expect(database.prepare('SELECT source, agent_name, tool_call_id FROM approval_requests').all()).toEqual([
      { source: 'terminal', agent_name: null, tool_call_id: null },
    ]);
    expect(await list(admin.cookie)).toMatchObject({ waiting: [{ id: approvalId, status: 'pending' }] });

    expect(await (await decide(admin.cookie, approvalId, 'approve')).json()).toMatchObject({ status: 'done' });
    expect(sent.filter((request) => request.url === DOMAIN_LIST)).toHaveLength(1);
    // No conversation asked, so none reads it back.
    expect(await outcome(approvalId)).toMatchObject({ error: 'Not found.' });
  });
});
