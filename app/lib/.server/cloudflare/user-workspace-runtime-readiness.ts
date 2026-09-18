import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { USER_WORKSPACE_RUNTIME_SERVICE } from '@cloudchef/user-workspace-runtime/protocol';
import { z } from 'zod';

const MAX_HEALTH_RESPONSE_BYTES = 1_024;
const readinessResponseSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal(USER_WORKSPACE_RUNTIME_SERVICE),
    runtimeVersion: z.string(),
  })
  .strict();

/** One readiness attempt; the surrounding Workflow step supplies durable retries. */
export async function waitForUserWorkspaceRuntimeReadiness(args: {
  endpoint: string;
  controlPlaneSecret: string;
  runtimeVersion: string;
  request?: typeof fetch;
}): Promise<void> {
  const response = await (args.request ?? fetch)(new URL('/v1/readiness', args.endpoint), {
    headers: { authorization: `Bearer ${args.controlPlaneSecret}` },
    signal: AbortSignal.timeout(8 * 60_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The user-owned workspace runtime is not ready (HTTP ${response.status}).`);
  }
  const payload = readinessResponseSchema.safeParse(
    await readJsonBodyWithLimit(response, MAX_HEALTH_RESPONSE_BYTES, 'Workspace runtime health'),
  );
  if (!payload.success || payload.data.runtimeVersion !== args.runtimeVersion) {
    throw new Error('The user-owned workspace runtime returned an invalid health response.');
  }
}
