import { copyJson } from '@earendil-works/chord';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';
import type { CloudflareApiOutcome } from '~/lib/.server/cloudflare/cloudflare-api-client';
import type { CloudflareChangeAnswer } from '~/lib/.server/cloudflare/cloudflare-api-proxy';
import { AGENT_NAME, commandEntries, conversationAgentHarness, type ConversationAgentHarness } from './harness';

/**
 * A change `cf` asks for from a command the agent runs: the runtime's CloudflareApiProxy hands it to the agent,
 * which keeps it in that command's place in the chat until the person decides, while the proxy asks again.
 */
const DELETE_SCRIPT: CloudflareApiRequest = {
  method: 'DELETE',
  url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old',
};
const COMMAND = 'exec-1';

const errorSchema = z.object({ errors: z.array(z.object({ message: z.string() })) });

function errorMessage(answer: CloudflareChangeAnswer): string | undefined {
  return answer.kind === 'answer' ? errorSchema.parse(JSON.parse(answer.body)).errors[0]?.message : undefined;
}

/** The agent's Cloudflare client, which sends an approved change with the account's authorization. */
function sentRequests(harness: ConversationAgentHarness, outcome: CloudflareApiOutcome) {
  const sent: CloudflareApiRequest[] = [];
  // SAFETY: the agent only calls `send` on the client it makes; this stands in for the real one.
  Reflect.set(harness.agent, 'createCloudflareApiClient', () => ({
    send: async (request: CloudflareApiRequest) => {
      sent.push(request);
      return outcome;
    },
  }));
  return sent;
}

beforeEach(() => {
  vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a change cf asks for in the person's own account", () => {
  it('waits for the person, then sends exactly that request once and answers cf with what Cloudflare said', async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    const sent = sentRequests(harness, {
      status: 'success',
      content: '{"success":true,"result":null}',
      requestId: 'ray-1',
      httpStatus: 200,
      truncated: false,
    });

    const asked = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: DELETE_SCRIPT });
    expect(asked.kind).toBe('waiting');
    const executionId = asked.kind === 'waiting' ? asked.executionId : '';
    // The chat shows it in the command's place, with the exact request to approve.
    expect(harness.agent.state.cloudflareExecutions).toEqual([
      expect.objectContaining({
        executionId,
        toolCallId: COMMAND,
        status: 'awaiting_approval',
        request: DELETE_SCRIPT,
      }),
    ]);
    await expect(harness.agent.workspaceCloudflareChangeOutcome({ toolCallId: COMMAND, executionId })).resolves.toEqual(
      { kind: 'waiting', executionId },
    );
    expect(sent).toEqual([]);

    await expect(harness.agent.approveCloudflareExecution({ executionId })).resolves.toMatchObject({
      execution: { status: 'succeeded' },
    });

    expect(sent).toEqual([DELETE_SCRIPT]);
    await expect(harness.agent.workspaceCloudflareChangeOutcome({ toolCallId: COMMAND, executionId })).resolves.toEqual(
      { kind: 'answer', status: 200, body: '{"success":true,"result":null}' },
    );
  });

  it('sends nothing when the person rejects it, and tells cf so', async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    const sent = sentRequests(harness, {
      status: 'success',
      content: '{}',
      requestId: null,
      httpStatus: 200,
      truncated: false,
    });
    const asked = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: DELETE_SCRIPT });
    const executionId = asked.kind === 'waiting' ? asked.executionId : '';

    await harness.agent.rejectCloudflareExecution({ executionId });

    const answer = await harness.agent.workspaceCloudflareChangeOutcome({ toolCallId: COMMAND, executionId });
    expect(answer).toMatchObject({ kind: 'answer', status: 403 });
    expect(errorMessage(answer)).toContain('declined');
    expect(sent).toEqual([]);
  });

  it('never sends a change whose command stopped asking, even when it is approved', async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    const sent = sentRequests(harness, {
      status: 'success',
      content: '{}',
      requestId: null,
      httpStatus: 200,
      truncated: false,
    });
    const asked = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: DELETE_SCRIPT });
    const executionId = asked.kind === 'waiting' ? asked.executionId : '';

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    await expect(harness.agent.approveCloudflareExecution({ executionId })).rejects.toMatchObject({ status: 409 });

    expect(sent).toEqual([]);
    expect(harness.cloudflareExecution(executionId)?.status).toBe('expired');
  });

  it('withdraws the change of a command that ended while it waited', async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    const asked = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: DELETE_SCRIPT });
    const executionId = asked.kind === 'waiting' ? asked.executionId : '';

    // What the exec tool does once its command ends, however it ended.
    // eslint-disable-next-line dot-notation
    harness.agent['settleCommandCloudflareChanges'](COMMAND);

    const answer = await harness.agent.workspaceCloudflareChangeOutcome({ toolCallId: COMMAND, executionId });
    expect(errorMessage(answer)).toContain('The command ended before anyone approved the change');
    await expect(harness.agent.approveCloudflareExecution({ executionId })).rejects.toMatchObject({ status: 409 });
  });

  it('lets a command ask for several changes, each waiting in its card in turn, and refuses another account', async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    const sent = sentRequests(harness, {
      status: 'success',
      content: '{"success":true,"result":null}',
      requestId: null,
      httpStatus: 200,
      truncated: false,
    });
    const older = { ...DELETE_SCRIPT, url: DELETE_SCRIPT.url.replace('/old', '/older') };
    const first = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: DELETE_SCRIPT });
    const firstId = first.kind === 'waiting' ? first.executionId : '';

    // The next change of the same command waits its turn behind the first.
    await expect(
      harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: older }),
    ).resolves.toEqual({ kind: 'queued' });

    await harness.agent.approveCloudflareExecution({ executionId: firstId });
    const second = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request: older });
    expect(second.kind).toBe('waiting');
    const secondId = second.kind === 'waiting' ? second.executionId : '';
    // Both are in the command's card: the first made, the second waiting for its own decision.
    expect(harness.agent.state.cloudflareExecutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executionId: firstId, toolCallId: COMMAND, status: 'succeeded' }),
        expect.objectContaining({ executionId: secondId, toolCallId: COMMAND, status: 'awaiting_approval' }),
      ]),
    );
    await harness.agent.approveCloudflareExecution({ executionId: secondId });
    expect(sent).toEqual([DELETE_SCRIPT, older]);

    const elsewhere = await harness.agent.proposeWorkspaceCloudflareChange({
      toolCallId: 'exec-2',
      request: { ...DELETE_SCRIPT, url: DELETE_SCRIPT.url.replace('account-1', 'account-2') },
    });
    expect(elsewhere).toMatchObject({ kind: 'answer', status: 403 });
    expect(errorMessage(elsewhere)).toContain('another Cloudflare account');
  });

  it('answers a change in a workspace with no Cloudflare connection with a refusal', async () => {
    const harness = await conversationAgentHarness();

    const answer = await harness.agent.proposeWorkspaceCloudflareChange({
      toolCallId: COMMAND,
      request: DELETE_SCRIPT,
    });

    expect(answer).toMatchObject({ kind: 'answer', status: 403 });
    expect(harness.agent.state.cloudflareExecutions ?? []).toEqual([]);
  });
});

describe("a team member's changes in the team's account", () => {
  it("files each change a command asks for with the team's admins, and gives them all to the command's output", async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    Object.assign(harness.env, { CLOUDCHEF_SHARED_ACCOUNT: '1' });
    const filed: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).endsWith('/runtime-projects/approvals/file')) {
        // Not one of the team's admins.
        return new Response('unavailable', { status: 503 });
      }
      filed.push(JSON.parse(String(init?.body)));
      return Response.json({ approvalId: `approval-${filed.length}`, expiresAt: 1, warning: null }, { status: 201 });
    });
    const older = { ...DELETE_SCRIPT, url: DELETE_SCRIPT.url.replace('/old', '/older') };

    for (const request of [DELETE_SCRIPT, older]) {
      const answer = await harness.agent.proposeWorkspaceCloudflareChange({ toolCallId: COMMAND, request });
      expect(answer).toMatchObject({ kind: 'answer', status: 202 });
      expect(errorMessage(answer)).toContain('sent to the team’s admins');
    }

    expect(filed).toEqual([
      expect.objectContaining({
        source: 'agent',
        toolCallId: COMMAND,
        changeNumber: 1,
        requestJson: JSON.stringify(DELETE_SCRIPT),
      }),
      expect.objectContaining({
        source: 'agent',
        toolCallId: COMMAND,
        changeNumber: 2,
        requestJson: JSON.stringify(older),
      }),
    ]);
    // eslint-disable-next-line dot-notation
    expect(harness.agent['settleCommandCloudflareChanges'](COMMAND)).toEqual([
      expect.objectContaining({ kind: 'cloudflare_request_filed', approvalId: 'approval-1', request: DELETE_SCRIPT }),
      expect.objectContaining({ kind: 'cloudflare_request_filed', approvalId: 'approval-2', request: older }),
    ]);
  });

  it("puts an admin's decision on a command's second change in place of that change, leaving the first waiting", async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    Object.assign(harness.env, { CLOUDCHEF_SHARED_ACCOUNT: '1' });
    const older = { ...DELETE_SCRIPT, url: DELETE_SCRIPT.url.replace('/old', '/older') };
    const filed = (approvalId: string, request: CloudflareApiRequest) => ({
      kind: 'cloudflare_request_filed',
      status: 'awaiting_team_admin',
      approvalId,
      accountId: 'account-1',
      request,
      riskNote: 'One of the team’s admins approves or rejects it.',
      expiresAt: Date.now() + 60_000,
      note: 'Filed.',
    });
    const command = 'cf workers scripts delete old && cf workers scripts delete older';
    await harness.agent.appendEntries(
      commandEntries(COMMAND, command, {
        command,
        exitCode: 1,
        stdout: '',
        stderr: 'Not changed yet',
        cloudflareChanges: [filed('approval-1', DELETE_SCRIPT), filed('approval-2', older)].map((change) =>
          copyJson(change),
        ),
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/runtime-projects/approvals/outcome')
        ? Response.json({
            agentName: AGENT_NAME,
            toolCallId: COMMAND,
            requestSha256: 'c'.repeat(64),
            status: 'rejected',
            result: null,
            outcome: { status: 'denied', summary: 'A team admin rejected this change.' },
          })
        : new Response('unavailable', { status: 503 }),
    );

    await expect(harness.agent.settleTeamApproval({ approvalId: 'approval-2', ownerId: 'owner-1' })).resolves.toBe(
      true,
    );

    const output = z
      .object({ output: z.object({ cloudflareChanges: z.array(z.looseObject({ kind: z.string() })) }) })
      .parse((await harness.messages())[0]?.parts[0]);
    expect(output.output.cloudflareChanges).toEqual([
      expect.objectContaining({ kind: 'cloudflare_request_filed', approvalId: 'approval-1' }),
      expect.objectContaining({
        kind: 'cloudflare_request_final_result',
        executionId: 'approval-2',
        status: 'rejected',
        outcome: { status: 'denied', summary: 'A team admin rejected this change.' },
      }),
    ]);
  });
});
