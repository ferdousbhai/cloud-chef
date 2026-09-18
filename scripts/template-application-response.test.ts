import { describe, expect, test, vi } from 'vitest';
import { finalizeApplicationResponse, withApplicationSecurityHeaders } from '../template/src/application-response';

describe('generated application response boundary', () => {
  test('adds the production application header baseline', () => {
    const response = withApplicationSecurityHeaders(new Response('app', { headers: { 'X-App': 'preserved' } }));

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-App')).toBe('preserved');
  });

  test('independently enforces the baseline without weakening stricter application CSP or HSTS', () => {
    const response = withApplicationSecurityHeaders(
      new Response('app', {
        headers: {
          'Content-Security-Policy': "default-src 'none'; script-src 'self'",
          'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
        },
      }),
    );

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self', base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
  });

  test('allows only CloudChef to frame a Workers version preview', () => {
    const response = withApplicationSecurityHeaders(new Response('preview'), { workersPreview: true });

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "base-uri 'self'; frame-ancestors https://cloudchef.build; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });

  test('raises a weaker HSTS response to the production minimum without dropping its flags', () => {
    const response = withApplicationSecurityHeaders(
      new Response('app', {
        headers: { 'Strict-Transport-Security': 'max-age=0; includeSubDomains' },
      }),
    );

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  });

  test('bounds malformed HSTS parsing and preserves future non-max-age directives', () => {
    const response = withApplicationSecurityHeaders(
      new Response('app', {
        headers: {
          'Strict-Transport-Security': `max-age=${'9'.repeat(1_024)}; includeSubDomains; future=value`,
        },
      }),
    );

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; future=value');
  });

  test('normalizes duplicate HSTS max-age directives', () => {
    const response = withApplicationSecurityHeaders(
      new Response('ok', {
        headers: {
          'Strict-Transport-Security': 'max-age=63072000; max-age=0; includeSubDomains',
        },
      }),
    );

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  });

  test('returns an Agent response by identity without wrapping it or fetching the app', async () => {
    const agentResponse = new Response('agent', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const fetchApplication = vi.fn(() => new Response('app'));

    const result = await finalizeApplicationResponse(
      new Request('https://app.example/agent'),
      agentResponse,
      fetchApplication,
    );

    expect(result).toBe(agentResponse);
    expect(result.headers.get('Upgrade')).toBe('websocket');
    expect(fetchApplication).not.toHaveBeenCalled();
  });

  test('derives the frame policy from the exact Workers version hostname', async () => {
    const preview = await finalizeApplicationResponse(
      new Request('https://12345678-cloudchef-app.account-subdomain.workers.dev/'),
      null,
      () => new Response('preview'),
    );
    const production = await finalizeApplicationResponse(
      new Request('https://cloudchef-app.account-subdomain.workers.dev/'),
      null,
      () => new Response('production'),
    );

    expect(preview.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://cloudchef.build');
    expect(preview.headers.get('X-Frame-Options')).toBeNull();
    expect(production.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(production.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
