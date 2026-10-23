import { describe, expect, it } from 'vitest';
import { gitHubRepositoryName, importReturnURL, isImportReturn } from './github-app.client';

describe('gitHubRepositoryName', () => {
  it('reads owner and name from the addresses people paste', () => {
    expect(gitHubRepositoryName('https://github.com/acme/storefront')).toBe('acme/storefront');
    expect(gitHubRepositoryName('github.com/acme/storefront.git')).toBe('acme/storefront');
    expect(gitHubRepositoryName(' https://www.github.com/acme/store.front/ ')).toBe('acme/store.front');
  });

  it('refuses anything that is not a github.com repository', () => {
    expect(gitHubRepositoryName('https://gitlab.com/acme/storefront')).toBeNull();
    expect(gitHubRepositoryName('https://github.com/acme')).toBeNull();
    expect(gitHubRepositoryName('https://github.com/acme/storefront/tree/main')).toBeNull();
  });
});

describe('import return', () => {
  it('comes back to the page it left with the dialog asked for', () => {
    const url = importReturnURL('https://cloudchef.build/?x=1');
    expect(new URL(url).searchParams.get('x')).toBe('1');
    expect(isImportReturn(new URL(url).search)).toBe(true);
    expect(isImportReturn('?x=1')).toBe(false);
  });
});
