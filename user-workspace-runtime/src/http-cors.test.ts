import { describe, expect, it } from 'vitest';
import { withCors } from './http-cors';

describe('user runtime CORS', () => {
  it('exposes the transcript identity required by the cross-origin browser client', () => {
    const response = withCors(
      new Response(null, {
        headers: {
          'X-CloudChef-Transcript-Agent': 'agent-1',
          'X-CloudChef-Transcript-Generation': '2',
          'X-CloudChef-Transcript-Subchat': '3',
        },
      }),
      'https://cloudchef.build',
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://cloudchef.build');
    expect(response.headers.get('Access-Control-Expose-Headers')?.split(', ')).toEqual([
      'X-CloudChef-Transcript-Agent',
      'X-CloudChef-Transcript-Generation',
      'X-CloudChef-Transcript-Subchat',
    ]);
  });
});
