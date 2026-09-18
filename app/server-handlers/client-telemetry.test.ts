import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientTelemetryAction } from './client-telemetry';

const validTelemetry = {
  schemaVersion: 1,
  event: 'preview_ready',
  level: 'info',
  journeyId: '00000000-0000-4000-8000-000000000001',
  occurredAt: '2026-08-04T12:00:00.000Z',
  page: 'chat',
  context: { outcome: 'success', workspaceRevision: 42 },
};

describe('clientTelemetryAction', () => {
  const limit = vi.fn().mockResolvedValue({ success: true });
  const env = { CLIENT_TELEMETRY_RATE_LIMITER: { limit } } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    limit.mockResolvedValue({ success: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('accepts and logs a bounded allowlisted event', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const request = new Request('https://cloudchef.build/api/client-telemetry', {
      method: 'POST',
      headers: { origin: 'https://cloudchef.build', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(validTelemetry),
    });

    const response = await clientTelemetryAction({ request, env });

    expect(response.status).toBe(202);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'client_telemetry', telemetry: validTelemetry }),
    );
  });

  it.each([
    ['prompt', 'private prompt'],
    ['generatedCode', 'export default secret'],
    ['rawToolOutput', 'credential'],
    ['url', 'https://cloudchef.build/chat/private'],
  ])('rejects the unapproved %s field', async (field, value) => {
    const response = await clientTelemetryAction({
      env,
      request: new Request('https://cloudchef.build/api/client-telemetry', {
        method: 'POST',
        headers: { origin: 'https://cloudchef.build' },
        body: JSON.stringify({ ...validTelemetry, [field]: value }),
      }),
    });

    expect(response.status).toBe(400);
  });

  it('requires an opaque event identifier for error events', async () => {
    const response = await clientTelemetryAction({
      env,
      request: new Request('https://cloudchef.build/api/client-telemetry', {
        method: 'POST',
        headers: { origin: 'https://cloudchef.build' },
        body: JSON.stringify({ ...validTelemetry, level: 'error' }),
      }),
    });

    expect(response.status).toBe(400);
  });

  it('accepts an opaque control-plane correlation ID and rejects a non-opaque one', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const submit = (correlationId: string) =>
      clientTelemetryAction({
        env,
        request: new Request('https://cloudchef.build/api/client-telemetry', {
          method: 'POST',
          headers: { origin: 'https://cloudchef.build' },
          body: JSON.stringify({ ...validTelemetry, correlationId }),
        }),
      });

    await expect(submit('00000000-0000-4000-8000-0000000000ab')).resolves.toMatchObject({ status: 202 });
    await expect(submit('user@example.com')).resolves.toMatchObject({ status: 400 });
  });

  it('rejects cross-origin browser submissions', async () => {
    const response = await clientTelemetryAction({
      env,
      request: new Request('https://cloudchef.build/api/client-telemetry', {
        method: 'POST',
        headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify(validTelemetry),
      }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects non-browser submissions that omit the Origin header', async () => {
    const response = await clientTelemetryAction({
      env,
      request: new Request('https://cloudchef.build/api/client-telemetry', {
        method: 'POST',
        body: JSON.stringify(validTelemetry),
      }),
    });

    expect(response.status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
  });

  it('rate limits before parsing or logging the payload', async () => {
    limit.mockResolvedValueOnce({ success: false });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const response = await clientTelemetryAction({
      env,
      request: new Request('https://cloudchef.build/api/client-telemetry', {
        method: 'POST',
        headers: { origin: 'https://cloudchef.build', 'CF-Connecting-IP': '192.0.2.5' },
        body: '{invalid',
      }),
    });

    expect(limit).toHaveBeenCalledWith({ key: '192.0.2.5' });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(info).not.toHaveBeenCalled();
  });
});
