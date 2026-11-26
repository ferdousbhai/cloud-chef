// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubConnection } from './OrgProjectsSection.client';

let root: Root | undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Every labelled button whose accessible name does not start with the text it shows. */
function mislabelledButtons(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].flatMap((button) => {
    const visible = button.textContent?.trim() ?? '';
    const label = button.getAttribute('aria-label') ?? '';
    return label.startsWith(visible) ? [] : [`"${visible}" labelled "${label}"`];
  });
}

describe('GitHub, in Settings', () => {
  it('names the GitHub accounts connected, with importing and disconnecting each behind it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <GitHubConnection
          orgId="org-1"
          github={[
            { installationId: 1, accountLogin: 'acme', accountType: 'Organization' },
            { installationId: 2, accountLogin: 'grace', accountType: 'User' },
          ]}
          onChanged={async () => undefined}
        />,
      ),
    );

    expect(document.body.textContent).toContain('GitHubacmegrace');
    expect(mislabelledButtons()).toEqual([]);
    // No list of projects, and nobody's access to one: those are on the projects home and in each project's sharing.
    expect(document.querySelector('ul')).toBeNull();
  });

  it('says so when none is connected', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<GitHubConnection orgId="org-1" github={[]} onChanged={async () => undefined} />),
    );
    expect(document.body.textContent).toContain('GitHubNot connected');
  });
});
