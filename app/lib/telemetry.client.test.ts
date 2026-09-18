import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('privacy-safe client telemetry', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  const sessionStorage = new Map<string, string>();
  const localStorage = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sessionStorage.clear();
    localStorage.clear();
    localStorage.set('cloudchef:telemetry:preference', 'enabled');
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('navigator', { doNotTrack: '0', globalPrivacyControl: false });
    vi.stubGlobal('window', {
      location: {
        href: 'https://cloudchef.build/chat/private-project?token=credential',
        pathname: '/chat/private-project',
      },
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        setItem: (key: string, value: string) => sessionStorage.set(key, value),
      },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        setItem: (key: string, value: string) => localStorage.set(key, value),
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends only allowlisted structured fields and never includes the current URL', async () => {
    const { captureMessage } = await import('./telemetry.client');

    await captureMessage('Unknown assistant message part', {
      level: 'warning',
      durationMs: 42,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      schemaVersion: 1,
      event: 'Unknown assistant message part',
      level: 'warning',
      page: 'chat',
      context: { durationMs: 42 },
    });
    expect(JSON.stringify(payload)).not.toContain('private-project');
    expect(JSON.stringify(payload)).not.toContain('credential');
  });

  it('records an opaque error-event ID without serializing exception details', async () => {
    const { captureException } = await import('./telemetry.client');

    await captureException(
      'Failed to start Cloudflare authorization',
      new Error('token=secret and user prompt contents'),
    );

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.errorEventId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.context).toEqual({ outcome: 'failure' });
    expect(JSON.stringify(payload)).not.toContain('token=secret');
    expect(JSON.stringify(payload)).not.toContain('user prompt contents');
  });

  it('honors Global Privacy Control and browser telemetry opt-out', async () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    const { captureProductEvent } = await import('./telemetry.client');

    await captureProductEvent('landing_viewed');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicit product telemetry opt-in', async () => {
    localStorage.delete('cloudchef:telemetry:preference');
    const { captureProductEvent } = await import('./telemetry.client');

    await captureProductEvent('landing_viewed');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.size).toBe(0);
  });

  it('echoes the control-plane correlation ID without exporting the browser journey ID', async () => {
    const { captureProductEvent } = await import('./telemetry.client');
    const { telemetryCorrelationIdStore } = await import('./cloudflare/runtime-session');
    telemetryCorrelationIdStore.set('00000000-0000-4000-8000-0000000000ab');

    await captureProductEvent('prompt_submitted');

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.correlationId).toBe('00000000-0000-4000-8000-0000000000ab');
    expect(payload.journeyId).not.toBe(payload.correlationId);
  });

  it('rejects a correlation ID that is not an opaque identifier', async () => {
    const { captureProductEvent } = await import('./telemetry.client');
    const { telemetryCorrelationIdStore } = await import('./cloudflare/runtime-session');
    telemetryCorrelationIdStore.set('user@example.com');

    await captureProductEvent('prompt_submitted');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('correlationId');
  });

  it('claims a funnel stage once even when session storage is cleared', async () => {
    const { captureProductEvent } = await import('./telemetry.client');

    await captureProductEvent('first_tool_completed', { outcome: 'success' });
    sessionStorage.clear();
    await captureProductEvent('first_tool_completed', { outcome: 'success' });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses a credential-free keepalive request', async () => {
    const { captureProductEvent } = await import('./telemetry.client');

    await captureProductEvent('prompt_submitted');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/client-telemetry',
      expect.objectContaining({ method: 'POST', keepalive: true, credentials: 'omit' }),
    );
  });
});
