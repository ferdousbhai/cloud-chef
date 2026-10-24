import { describe, expect, it } from 'vitest';
import { PREVIEW_SANDBOX } from '~/components/workbench/Preview';
import { appSitePresentation, appSiteUrl, emptyAppSiteState } from './app-site';

const site = 'https://cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev';

describe('appSiteUrl', () => {
  it('accepts only the HTTPS origin of a project’s production Worker', () => {
    expect(appSiteUrl(site)).toBe(`${site}/`);
    expect(PREVIEW_SANDBOX.split(' ')).toEqual(expect.arrayContaining(['allow-same-origin', 'allow-scripts']));
  });

  it.each([
    'https://workers.dev',
    'https://workers.dev.example.com',
    'https://cloudchef.build',
    'http://cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev',
    'https://user:password@cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev',
    'https://cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev:8443',
    // A database's name, and a version preview URL that would serve an earlier version on its data.
    'https://cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-storage.account.workers.dev',
    'https://d6738251-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev',
    '/relative-site',
    'not a url',
  ])('rejects an address that is not a production Worker’s: %s', (url) => {
    expect(appSiteUrl(url)).toBeNull();
  });
});

describe('appSitePresentation', () => {
  it('shows the live site while a newer revision publishes', () => {
    const presentation = appSitePresentation({
      url: site,
      revision: 'a'.repeat(64),
      deployment: { status: 'deploying', revision: 'b'.repeat(64), workspaceRevision: 2 },
    });

    expect(presentation).toEqual({ url: `${site}/`, revision: 'a'.repeat(64), status: 'publishing', error: null });
  });

  it('reports a failed deployment with its error, keeping the site it serves', () => {
    const presentation = appSitePresentation({
      url: site,
      revision: 'a'.repeat(64),
      deployment: { status: 'failed', error: 'The build failed: lint' },
    });

    expect(presentation.url).toBe(`${site}/`);
    expect(presentation.status).toBe('failed');
    expect(presentation.error).toBe('The build failed: lint');
  });

  it('frames nothing at an address that is not a production Worker’s', () => {
    const presentation = appSitePresentation({ ...emptyAppSiteState(), url: 'https://example.com' });

    expect(presentation.url).toBeNull();
    expect(presentation.status).toBe('idle');
  });
});
