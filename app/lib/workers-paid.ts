import { z } from 'zod';

export const WORKERS_PAID_REQUIRED_MARKER = 'CLOUDCHEF_WORKERS_PAID_REQUIRED:';

export function workersPaidRequiredMessage(): string {
  return `${WORKERS_PAID_REQUIRED_MARKER} Your connected Cloudflare account exhausted its free Workers AI allocation. Review and explicitly authorize Workers Paid in Cloudflare to continue; CloudChef did not upgrade your plan.`;
}

export function isWorkersAiFreeAllocationError(error: unknown): boolean {
  return /(free\s+(?:ai\s+)?allocation|neuron(?:s)?\s+(?:limit|quota)|daily\s+(?:ai\s+)?limit|upgrade\s+to\s+workers\s+paid|workers\s+paid\s+(?:plan\s+)?required)/i.test(
    providerErrorDetails(error),
  );
}

/**
 * Provider SDKs hang the upstream payload off the thrown error under a couple of names.
 * Each field falls back independently so an unexpected shape on one cannot hide the other.
 */
const providerErrorPayloadSchema = z.looseObject({
  responseBody: z.string().optional().catch(undefined),
  data: z.string().optional().catch(undefined),
});

function providerErrorDetails(error: unknown): string {
  const parsed = providerErrorPayloadSchema.safeParse(error);
  const payload = parsed.success ? parsed.data : undefined;
  return [
    error instanceof Error ? error.message : String(error),
    payload?.responseBody ?? '',
    payload?.data ?? '',
  ].join(' ');
}
