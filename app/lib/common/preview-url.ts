/**
 * A project's preview Worker at its workers.dev address:
 * `https://<first 8 of identity>-cloudchef-<identity>-preview.<account>.workers.dev` (see `appResourceName`).
 */
export function previewWorkerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const workersPreview =
      /^([0-9a-f]{8})-cloudchef-\1-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-preview\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(
        url.hostname,
      );
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && workersPreview ? url.href : null;
  } catch {
    return null;
  }
}
