/** A project's preview Worker at its workers.dev address: `https://<app>-preview.<account>.workers.dev`. */
export function previewWorkerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const workersPreview =
      /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?-preview\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(
        url.hostname,
      );
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && workersPreview ? url.href : null;
  } catch {
    return null;
  }
}
