// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCloudflareReturnURL, signInWithCloudflare } from './auth-client';
import { PENDING_SUBMIT_STORAGE_KEY } from '~/utils/constants';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('the submit an authorization was asked to finish', () => {
  // A same-document destination, because jsdom leaves cross-document navigation unimplemented.
  function stubAuthorizationStart() {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ authorizationUrl: `${window.location.href.split('#')[0]}#cloudflare-authorization` }),
        ),
    );
  }

  test('travels with the connection the submit started', async () => {
    stubAuthorizationStart();

    await signInWithCloudflare('http://localhost/', { continuePrompt: '  Build a launch checklist.  ' });

    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBe('Build a launch checklist.');
  });

  test('is dropped by any connection no submit started', async () => {
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, 'Build a launch checklist.');
    stubAuthorizationStart();

    // Connecting from settings or the account card must never resume someone else's build.
    await signInWithCloudflare('http://localhost/settings');

    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBeNull();
  });

  test('is dropped when the authorization never starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Cloudflare authorization is unavailable.' }, { status: 503 })),
    );

    await expect(
      signInWithCloudflare('http://localhost/', { continuePrompt: 'Build a launch checklist.' }),
    ).rejects.toThrow('Cloudflare authorization is unavailable.');
    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBeNull();
  });
});

describe('Cloudflare return URL', () => {
  test('returns OAuth directly to the same-origin builder destination', () => {
    expect(
      createCloudflareReturnURL('https://cloudchef.build/chat/project?panel=code#preview', 'https://cloudchef.build'),
    ).toBe('https://cloudchef.build/chat/project?panel=code#preview');
  });

  test('rejects external and protocol-relative continuations', () => {
    expect(createCloudflareReturnURL('https://attacker.example/path', 'https://cloudchef.build')).toBe(
      'https://cloudchef.build/',
    );
    expect(createCloudflareReturnURL('https://cloudchef.build//attacker.example', 'https://cloudchef.build')).toBe(
      'https://cloudchef.build/',
    );
  });

  test('resumes the original destination after a failed authorization', () => {
    expect(
      createCloudflareReturnURL(
        'https://cloudchef.build/settings?continue=%2Fchat%2Fproject&cloudflare_authorization=failed#cloudflare',
        'https://cloudchef.build',
      ),
    ).toBe('https://cloudchef.build/chat/project');
    expect(
      createCloudflareReturnURL(
        'https://cloudchef.build/settings?continue=%2F%5Cattacker.example&cloudflare_authorization=failed',
        'https://cloudchef.build',
      ),
    ).toBe('https://cloudchef.build/settings');
  });
});
