import { describe, expect, test, vi } from 'vitest';
import { finalizeApplicationResponse, withApplicationSecurityHeaders } from '../template/src/application-response';

describe('generated application response boundary', () => {
  test('adds the application header baseline, letting only CloudChef frame the app', () => {
    const response = withApplicationSecurityHeaders(
      new Response('app', { headers: { 'X-App': 'preserved', 'X-Frame-Options': 'SAMEORIGIN' } }),
    );

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "base-uri 'self'; frame-ancestors https://cloudchef.build; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBeNull();
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
      "default-src 'none'; script-src 'self', base-uri 'self'; frame-ancestors https://cloudchef.build; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
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

    const result = await finalizeApplicationResponse(agentResponse, fetchApplication);

    expect(result).toBe(agentResponse);
    expect(result.headers.get('Upgrade')).toBe('websocket');
    expect(fetchApplication).not.toHaveBeenCalled();
  });
});
