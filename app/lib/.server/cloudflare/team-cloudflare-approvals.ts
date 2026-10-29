import { z } from 'zod';
import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';
import { cloudflareApiErrorBody, type CloudflareChangeAnswer } from './cloudflare-api-proxy';
import type { RuntimeConnectionIdentity } from './cloudflare-api-runtime-identity';
import { postRuntimeRoute } from './user-workspace-cloudflare-credential';

/**
 * Where a team member's change came from, as the team's admins see it: a command the member's agent ran (its result
 * is written back to that command in the chat), or the member's own terminal.
 */
export type TeamChangeSource = { source: 'agent'; agentName: string; toolCallId: string } | { source: 'terminal' };

export type TeamChangeFiling =
  | { kind: 'filed'; approvalId: string; expiresAt: number; warning: string | null }
  | { kind: 'refused'; answer: CloudflareChangeAnswer };

const filedApprovalSchema = z.object({
  approvalId: z.string(),
  expiresAt: z.number(),
  warning: z.string().nullable(),
});
const refusalSchema = z.object({ error: z.string() });

/** What `cf` is told of a change filed for the team's admins: nothing changed yet, and who decides. */
export const TEAM_FILED_ANSWER: CloudflareChangeAnswer = {
  kind: 'answer',
  status: 202,
  body: cloudflareApiErrorBody(
    'Not changed yet: this was sent to the team’s admins to approve. CloudChef makes the change once one of ' +
      'them approves it.',
  ),
};

/**
 * Files a team member's change for the team's admins. The member's workspace never holds the team account's
 * authorization: the control plane checks the change, and sends it once an admin approves it.
 */
export async function fileTeamCloudflareChange(
  env: Parameters<typeof postRuntimeRoute>[0],
  identity: RuntimeConnectionIdentity,
  from: TeamChangeSource,
  request: CloudflareApiRequest,
): Promise<TeamChangeFiling> {
  const answer = await postRuntimeRoute(env, identity, 'runtime-projects/approvals/file', {
    ...from,
    requestJson: JSON.stringify(request),
  });
  const body: unknown = await answer.json().catch(() => null);
  const filed = filedApprovalSchema.safeParse(body);
  if (!answer.ok || !filed.success) {
    return {
      kind: 'refused',
      answer: {
        kind: 'answer',
        status: answer.status === 403 ? 403 : 502,
        body: cloudflareApiErrorBody(
          refusalSchema.safeParse(body).data?.error ?? 'The change couldn’t be sent to the team’s admins. Try again.',
        ),
      },
    };
  }
  return { kind: 'filed', ...filed.data };
}
