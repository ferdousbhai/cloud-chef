import { describe, expect, it } from 'vitest';
import { withCors } from './http-cors';

describe('user runtime CORS', () => {
  it('allows the requesting origin and exposes no response headers', () => {
    const response = withCors(new Response(null), 'https://cloudchef.build');

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://cloudchef.build');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBeNull();
  });
});
