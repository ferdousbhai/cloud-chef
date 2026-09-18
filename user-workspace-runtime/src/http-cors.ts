const TRANSCRIPT_IDENTITY_HEADERS = [
  'X-CloudChef-Transcript-Agent',
  'X-CloudChef-Transcript-Generation',
  'X-CloudChef-Transcript-Subchat',
] as const;

export function withCors(response: Response, origin: string | null): Response {
  if (!origin || response.webSocket) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Expose-Headers', TRANSCRIPT_IDENTITY_HEADERS.join(', '));
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
