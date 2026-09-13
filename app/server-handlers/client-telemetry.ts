import { z } from 'zod';
import { ALL_CLIENT_TELEMETRY_EVENTS } from '~/lib/client-telemetry-events';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';

const MAX_CLIENT_TELEMETRY_BYTES = 8 * 1024;
const CLIENT_TELEMETRY_RATE_LIMIT_RETRY_SECONDS = 60;
const clientTelemetrySchema = z
  .object({
    schemaVersion: z.literal(1),
    event: z.enum(ALL_CLIENT_TELEMETRY_EVENTS),
    level: z.enum(['error', 'warning', 'info']),
    journeyId: z.uuid(),
    // Minted by the control plane and echoed back by the browser, so a funnel
    // event joins the request that issued it without the browser-owned journey
    // ID ever becoming a server-side join key.
    correlationId: z.uuid().optional(),
    errorEventId: z.uuid().optional(),
    occurredAt: z.iso.datetime(),
    page: z.enum(['home', 'settings', 'chat', 'other']),
    context: z
      .object({
        outcome: z.enum(['success', 'failure', 'cancelled']).optional(),
        failureReason: z
          .enum(['authorization', 'network', 'timeout', 'validation', 'deployment', 'unknown'])
          .optional(),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(24 * 60 * 60 * 1_000)
          .optional(),
        retryCount: z.number().int().nonnegative().max(100).optional(),
        workspaceRevision: z.number().int().nonnegative().optional(),
        previewMode: z.enum(['production', 'dev']).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.level === 'error' && !value.errorEventId) {
      context.addIssue({
        code: 'custom',
        path: ['errorEventId'],
        message: 'Error telemetry requires an error-event ID.',
      });
    }
  });

export async function clientTelemetryAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    return Response.json({ error: 'Cross-origin telemetry is not accepted.' }, { status: 403 });
  }
  const { success } = await env.CLIENT_TELEMETRY_RATE_LIMITER.limit({
    key: request.headers.get('CF-Connecting-IP') ?? 'missing-client-ip',
  });
  if (!success) {
    return Response.json(
      { error: 'Telemetry rate limit exceeded.' },
      { status: 429, headers: { 'Retry-After': String(CLIENT_TELEMETRY_RATE_LIMIT_RETRY_SECONDS) } },
    );
  }
  try {
    const telemetry = clientTelemetrySchema.parse(
      await readJsonBodyWithLimit(request, MAX_CLIENT_TELEMETRY_BYTES, 'Client telemetry'),
    );
    console.info({
      event: 'client_telemetry',
      acceptedAt: new Date().toISOString(),
      telemetry,
    });
    return new Response(null, { status: 202 });
  } catch {
    return Response.json({ error: 'Invalid client telemetry.' }, { status: 400 });
  }
}

function isSameOriginBrowserRequest(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin !== requestUrl.origin) {
    return false;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}
