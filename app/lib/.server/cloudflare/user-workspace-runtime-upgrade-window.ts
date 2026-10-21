import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { z } from 'zod';

const MAX_UPGRADE_WINDOW_RESPONSE_BYTES = 1_024;
const UPGRADE_WINDOW_TIMEOUT_MS = 30_000;
const claimResponseSchema = z.union([
  z.object({ granted: z.literal(true) }).strict(),
  z.object({ granted: z.literal(false), busy: z.number().int().min(0) }).strict(),
]);

/**
 * `unsupported`: a runtime from before the upgrade window existed, which answers the route as a
 * browser request without a capability. It cannot say whether it is busy.
 */
type UserWorkspaceRuntimeUpgradeWindow =
  { status: 'granted' } | { status: 'busy'; busy: number } | { status: 'unsupported' };

/**
 * Ask a live workspace runtime for the window to redeploy it in: granted only while none of its agents
 * is running a turn, validation, preview, deployment or approved Cloudflare request, or just finished
 * one. Any other failure throws, for the Workflow step to retry; it is never taken as idle.
 */
export async function claimUserWorkspaceRuntimeUpgradeWindow(args: {
  endpoint: string;
  controlPlaneSecret: string;
  targetVersion: string;
  request?: typeof fetch;
}): Promise<UserWorkspaceRuntimeUpgradeWindow> {
  const response = await (args.request ?? fetch)(new URL('/v1/upgrade-window', args.endpoint), {
    method: 'POST',
    headers: { authorization: `Bearer ${args.controlPlaneSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetVersion: args.targetVersion }),
    signal: AbortSignal.timeout(UPGRADE_WINDOW_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 'unsupported' };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The workspace runtime could not report its activity (HTTP ${response.status}).`);
  }
  const claim = claimResponseSchema.safeParse(
    await readJsonBodyWithLimit(response, MAX_UPGRADE_WINDOW_RESPONSE_BYTES, 'Workspace runtime upgrade window'),
  );
  if (!claim.success) {
    throw new Error('The workspace runtime returned an invalid upgrade window response.');
  }
  return claim.data.granted ? { status: 'granted' } : { status: 'busy', busy: claim.data.busy };
}

/**
 * Keep the claimed window open (`hold`) while the upgrade rolls out the container image and waits for
 * the new runtime, or close it (`release`) once that runtime serves. Asked of the runtime just deployed,
 * which has these routes; any failure throws, for the Workflow step to retry.
 */
export async function changeUserWorkspaceRuntimeUpgradeWindow(args: {
  change: 'hold' | 'release';
  endpoint: string;
  controlPlaneSecret: string;
  targetVersion: string;
  request?: typeof fetch;
}): Promise<void> {
  const response = await (args.request ?? fetch)(new URL('/v1/upgrade-window', args.endpoint), {
    method: args.change === 'hold' ? 'PUT' : 'DELETE',
    headers: { authorization: `Bearer ${args.controlPlaneSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetVersion: args.targetVersion }),
    signal: AbortSignal.timeout(UPGRADE_WINDOW_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`The workspace runtime could not ${args.change} its upgrade window (HTTP ${response.status}).`);
  }
}
