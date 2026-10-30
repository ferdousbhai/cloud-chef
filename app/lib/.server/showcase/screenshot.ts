/**
 * A public project's screenshot, taken by Browser Rendering in CloudChef's own account (`BROWSER`): it loads the
 * site's public address as any visitor would, with no cookies and no CloudChef credentials, at 1280x800, waits for
 * the network to go quiet (at most 10 seconds), and captures a WebP.
 */

const VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 10_000;
/** A screenshot past this is not one of a site's first screen. */
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

/** The screenshot, or null when the site couldn't be loaded (it is tried again at its next publish). */
export async function takeScreenshot(
  env: Env,
  siteUrl: string,
): Promise<{ bytes: Uint8Array; contentType: 'image/webp'; width: number; height: number } | null> {
  const url = new URL(siteUrl);
  if (url.protocol !== 'https:') {
    return null;
  }
  const response = await env.BROWSER.quickAction('screenshot', {
    url: url.toString(),
    viewport: VIEWPORT,
    gotoOptions: { waitUntil: 'networkidle0', timeout: NAVIGATION_TIMEOUT_MS },
    bestAttempt: true,
    cacheTTL: 0,
    screenshotOptions: { type: 'webp', quality: 80 },
  });
  if (response.status === 429 || response.status >= 500) {
    // Browser Rendering busy: the queue tries again.
    throw new Error(`Browser Rendering answered ${response.status}.`);
  }
  if (!response.ok) {
    console.warn({ event: 'showcase_screenshot_failed', status: response.status });
    await response.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    return null;
  }
  return { bytes, contentType: 'image/webp', ...VIEWPORT };
}

/**
 * Whether a picture may be shown at once ('ready') or waits for an operator ('pending'). This is where an image
 * classifier for sexual or violent content belongs (docs/proposals/showcase-and-feed.md, Media checks); none is bound
 * to the control plane yet, so pictures are shown, and reports are how one is taken down.
 */
export async function classifyMedia(_env: Env, _bytes: Uint8Array, _contentType: string): Promise<'ready' | 'pending'> {
  return 'ready';
}
