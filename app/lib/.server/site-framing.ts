const CHECK_TIMEOUT_MS = 4_000;

/**
 * Whether a site lets `origin` show it in a frame, from the headers its page answers with. A CSP
 * `frame-ancestors` decides when there is one, as browsers do; otherwise `X-Frame-Options` (`DENY`, or
 * `SAMEORIGIN` from another origin) refuses. Null when the site can't be reached now.
 */
export async function siteAllowsFraming(
  url: string,
  origin: string,
  fetchSite: (url: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<boolean | null> {
  let response: Response;
  try {
    response = await fetchSite(url, { redirect: 'follow', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch {
    return null;
  }
  await response.body?.cancel().catch(() => undefined);
  const siteOrigin = new URL(response.url || url).origin;
  const ancestors = (response.headers.get('content-security-policy') ?? '')
    .split(/[;,]/)
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name?.toLowerCase() === 'frame-ancestors')
    .map(([, ...sources]) => sources.map((source) => source.toLowerCase().replace(/\/$/, '')));
  if (ancestors.length > 0) {
    // Every policy has to allow it.
    return ancestors.every((sources) =>
      sources.some(
        (source) =>
          source === '*' || source === 'https:' || source === origin || (source === "'self'" && siteOrigin === origin),
      ),
    );
  }
  const frameOptions = response.headers.get('x-frame-options')?.trim().toLowerCase();
  if (frameOptions === 'deny') {
    return false;
  }
  return frameOptions === 'sameorigin' ? siteOrigin === origin : true;
}
