import { useEffect, useState } from 'react';
import { z } from 'zod';
import { getJson, postJson } from '~/lib/json-request';

const outcomeSchema = z.object({ summary: z.string(), content: z.string().optional() });

const approvalSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  kind: z.literal('cloudflare_change'),
  requester: z.object({ name: z.string(), email: z.string() }),
  request: z.object({ method: z.string(), url: z.string(), body: z.unknown().optional() }),
  warning: z.string().nullable(),
  status: z.enum(['pending', 'sending', 'done', 'rejected', 'expired']),
  result: z.enum(['succeeded', 'failed', 'indeterminate']).nullable(),
  outcome: outcomeSchema.nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type Approval = z.infer<typeof approvalSchema>;

const productionRequestSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  previewUrl: z.string().nullable(),
  requesterName: z.string(),
  requesterEmail: z.string(),
  createdAt: z.number(),
  updatedAt: z.number().nullable(),
});
export type ProductionRequest = z.infer<typeof productionRequestSchema>;

const approvalsSchema = z.object({
  admin: z.boolean(),
  waiting: z.array(approvalSchema),
  decided: z.array(approvalSchema),
  productionRequests: z.array(productionRequestSchema),
});
export type Approvals = z.infer<typeof approvalsSchema>;

/** What waits for the person as an admin of their teams, and what was decided lately. */
export function loadApprovals(signal?: AbortSignal): Promise<Approvals> {
  return getJson('/api/approvals', approvalsSchema, 'Approvals could not be loaded. Try again.', signal);
}

const decidedSchema = z.object({
  status: z.enum(['done', 'rejected']),
  result: z.enum(['succeeded', 'failed', 'indeterminate']).optional(),
  outcome: outcomeSchema.optional(),
});

/** Approves (CloudChef sends the change once) or rejects a member's change. */
export function decideApproval(id: string, decision: 'approve' | 'reject'): Promise<z.infer<typeof decidedSchema>> {
  return postJson('/api/approvals/decide', { id, decision }, decidedSchema, 'That couldn’t be saved. Try again.');
}

/** How many requests wait for the person as a team admin; 0 when they aren't one, or until it is known. */
export function useWaitingApprovals(admin: boolean): number {
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!admin) {
      return undefined;
    }
    const controller = new AbortController();
    loadApprovals(controller.signal)
      .then((approvals) => setWaiting(approvals.waiting.length + approvals.productionRequests.length))
      .catch(() => undefined);
    return () => controller.abort();
  }, [admin]);
  return admin ? waiting : 0;
}
