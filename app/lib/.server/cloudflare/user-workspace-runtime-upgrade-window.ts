import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { z } from 'zod';

const MAX_UPGRADE_WINDOW_RESPONSE_BYTES = 1_024;
const UPGRADE_WINDOW_TIMEOUT_MS = 30_000;
const claimResponseSchema = z.union([
  z.object({ granted: z.literal(true) }).strict(),
  z.object({ granted: z.literal(false), busy: z.number().int().min(0) }).strict(),
]);

/** Names the upgrade asking, so another cannot claim, renew or release the window it holds. */
const UPGRADE_WINDOW_HOLDER_HEADER = 'cloudchef-upgrade-holder';

function upgradeWindowHeaders(controlPlaneSecret: string, holder: string): HeadersInit {
  return {
    authorization: `Bearer ${controlPlaneSecret}`,
    'content-type': 'application/json',
    [UPGRADE_WINDOW_HOLDER_HEADER]: holder,
  };
}

type UserWorkspaceRuntimeUpgradeWindow = { status: 'granted' } | { status: 'busy'; busy: number };

/**
 * Ask a live workspace runtime for the window to redeploy it in: granted only while none of its agents
 * is running a turn, validation, preview, deployment or approved Cloudflare request, or just finished
 * one. Any other failure throws, for the Workflow step to retry; it is never taken as idle.
 */
export async function claimUserWorkspaceRuntimeUpgradeWindow(args: {
  endpoint: string;
  controlPlaneSecret: string;
  targetVersion: string;
  /** The upgrade's Workflow instance. */
  holder: string;
}): Promise<UserWorkspaceRuntimeUpgradeWindow> {
  const response = await fetch(new URL('/v1/upgrade-window', args.endpoint), {
    method: 'POST',
    headers: upgradeWindowHeaders(args.controlPlaneSecret, args.holder),
    body: JSON.stringify({ targetVersion: args.targetVersion }),
    signal: AbortSignal.timeout(UPGRADE_WINDOW_TIMEOUT_MS),
  });
  // A refused secret is a failure to retry, never a reason to redeploy without asking.
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new RuntimeSecretRefusedError();
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

/** The runtime refused the secret its upgrade window was asked with. */
export class RuntimeSecretRefusedError extends Error {
  constructor() {
    super('The workspace runtime refused the control plane secret for its upgrade window.');
    this.name = 'RuntimeSecretRefusedError';
  }
}

/**
 * The runtime would not open a window that lapsed again, since work started on it while none was open:
 * the upgrade waits for that work, as it waits for a busy workspace before it redeploys.
 */
export class RuntimeUpgradeWindowRefusedError extends Error {
  constructor(readonly busy: number) {
    super('The workspace runtime started work while its upgrade window had lapsed.');
    this.name = 'RuntimeUpgradeWindowRefusedError';
  }
}

const holdRefusalSchema = z.object({ held: z.literal(false), busy: z.number().int().min(0) }).strict();

/**
 * Keep the claimed window open (`hold`) while the upgrade rolls out the container image and waits for
 * the new runtime, or close it (`release`) once that runtime serves. Asked of the runtime just deployed,
 * which has these routes. A hold of a window that lapsed while work started throws
 * `RuntimeUpgradeWindowRefusedError`; any other failure throws, for the Workflow step to retry.
 */
export async function changeUserWorkspaceRuntimeUpgradeWindow(args: {
  change: 'hold' | 'release';
  endpoint: string;
  controlPlaneSecret: string;
  targetVersion: string;
  /** The upgrade's Workflow instance, the one that claimed the window. */
  holder: string;
}): Promise<void> {
  const response = await fetch(new URL('/v1/upgrade-window', args.endpoint), {
    method: args.change === 'hold' ? 'PUT' : 'DELETE',
    headers: upgradeWindowHeaders(args.controlPlaneSecret, args.holder),
    body: JSON.stringify({ targetVersion: args.targetVersion }),
    signal: AbortSignal.timeout(UPGRADE_WINDOW_TIMEOUT_MS),
  });
  if (args.change === 'hold' && response.status === 409) {
    const refusal = holdRefusalSchema.safeParse(
      await readJsonBodyWithLimit(response, MAX_UPGRADE_WINDOW_RESPONSE_BYTES, 'Workspace runtime upgrade window'),
    );
    if (refusal.success) {
      throw new RuntimeUpgradeWindowRefusedError(refusal.data.busy);
    }
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`The workspace runtime could not ${args.change} its upgrade window (HTTP ${response.status}).`);
  }
}
