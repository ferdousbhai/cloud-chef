// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgProjectsSection } from './OrgProjectsSection.client';

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

describe('OrgProjectsSection', () => {
  it("names each project button by the text it shows, then what it's for", async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <OrgProjectsSection
          orgId="org-1"
          github={[
            { installationId: 1, accountLogin: 'acme', accountType: 'Organization' },
            { installationId: 2, accountLogin: 'grace', accountType: 'User' },
          ]}
          projects={[
            {
              id: 'project-1',
              name: 'Storefront',
              createdFrom: 'github',
              deploysWith: 'workers_builds',
              repo: 't-project-1',
              importRepoFullName: 'acme/storefront',
              access: [{ userId: 'user-2', role: 'view' }],
            },
          ]}
          members={[
            { userId: 'user-1', name: 'Grace', email: 'grace@example.com', role: 'admin' },
            { userId: 'user-2', name: 'Ada', email: 'ada@example.com', role: 'member' },
          ]}
          onChanged={async () => undefined}
        />,
      ),
    );

    expect(mislabelledButtons()).toEqual([]);
    // A project from GitHub has its own way to go live; only one that didn't come from there is told to connect it.
    expect(document.body.textContent).not.toContain('Continue with Artifacts');
    expect(document.querySelector('button[aria-label="Delete Storefront"]')).not.toBeNull();
    expect(mislabelledButtons()).toEqual([]);
  });

  it("sets each member's access with one choice, and lists admins as owners", async () => {
    const posted: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/organizations/projects/access') {
        posted.push(JSON.parse(String(init?.body)));
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const onChanged = vi.fn(async () => undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <OrgProjectsSection
          orgId="org-1"
          github={[]}
          projects={[
            {
              id: 'project-1',
              name: 'Storefront',
              createdFrom: 'zip',
              deploysWith: 'workers_builds',
              repo: 'p-draft',
              importRepoFullName: null,
              access: [{ userId: 'user-2', role: 'view' }],
            },
          ]}
          members={[
            { userId: 'user-1', name: 'Grace', email: 'grace@example.com', role: 'admin' },
            { userId: 'user-2', name: 'Ada', email: 'ada@example.com', role: 'member' },
          ]}
          onChanged={onChanged}
        />,
      ),
    );

    const found = document.querySelector('select[aria-label="Ada\'s access to Storefront"]');
    const select = found instanceof HTMLSelectElement ? found : null;
    expect(select?.value).toBe('view');
    expect(document.body.textContent).toContain('Owner');
    expect(document.body.textContent).toContain('Continue with Artifacts');

    await act(async () => {
      if (select) {
        select.value = 'edit';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    expect(posted).toEqual([{ orgId: 'org-1', projectId: 'project-1', userId: 'user-2', role: 'edit' }]);
    expect(onChanged).toHaveBeenCalled();
  });
});
