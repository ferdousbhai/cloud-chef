/** CloudChef's own address: where every emailed link and every OAuth return points. */
export const CANONICAL_ORIGIN = 'https://cloudchef.build';

/**
 * The origin an emailed link or an OAuth redirect names: CloudChef's own, whichever hostname the
 * request reached, so a request through any other (a Worker preview URL, a retired domain) can't
 * make CloudChef email a link to it or have a provider send an authorization code back to it. Local
 * development keeps its own origin.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url.origin : CANONICAL_ORIGIN;
}
