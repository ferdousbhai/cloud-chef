// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button?.click());
}

describe('OrgProjectsSection', () => {
  it("names each project and request button by the text it shows, then what it's for", async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <OrgProjectsSection
          orgId="org-1"
          github={{ accountLogin: 'acme', accountType: 'Organization' }}
          projects={[
            {
              id: 'project-1',
              name: 'Storefront',
              repo: null,
              origin: 'imported',
              importRepoFullName: 'acme/storefront',
              access: [],
            },
          ]}
          members={[]}
          productionRequests={[
            {
              id: 'request-1',
              title: 'Todo app',
              note: null,
              previewUrl: null,
              repo: 'p-todo',
              commit: 'c'.repeat(40),
              requesterName: 'Ada',
              requesterEmail: 'ada@example.com',
              updatedAt: null,
            },
          ]}
          onChanged={async () => undefined}
        />,
      ),
    );

    expect(mislabelledButtons()).toEqual([]);
    await click('Unlink');
    await click('Decline');
    expect(document.querySelector('button[aria-label="Decline request: Todo app"]')).not.toBeNull();
    expect(mislabelledButtons()).toEqual([]);
  });
});
