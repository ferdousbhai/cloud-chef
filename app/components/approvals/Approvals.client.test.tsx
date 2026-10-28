// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval, Approvals as ApprovalsList } from '~/lib/cloudflare/approvals.client';
import { Approvals } from './Approvals.client';

const change: Approval = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  orgName: 'Sites',
  kind: 'cloudflare_change',
  requester: { name: 'Sara', email: 'sara@example.com' },
  request: {
    method: 'POST',
    url: 'https://api.cloudflare.com/client/v4/accounts/a/workers/domains',
    body: { hostname: 'shop.example.com', service: 'shop' },
  },
  warning: 'This puts shop.example.com on the Worker shop.',
  status: 'pending',
  result: null,
  outcome: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: Date.now() - 5 * 60_000,
  expiresAt: Date.now() + 86_400_000,
};

let listed: ApprovalsList;
const decisions: unknown[] = [];
let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  decisions.length = 0;
  listed = { admin: true, waiting: [change], decided: [], productionRequests: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/approvals') {
        return Response.json(listed);
      }
      if (url === '/api/approvals/decide') {
        decisions.push(JSON.parse(String(init?.body)));
        listed = {
          ...listed,
          waiting: [],
          decided: [{ ...change, status: 'done', result: 'succeeded', decidedBy: 'Ada', decidedAt: Date.now() }],
        };
        return Response.json({ status: 'done', result: 'succeeded' });
      }
      return Response.json({ error: 'Not here.' }, { status: 404 });
    }),
  );
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<Approvals />));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) {
    throw new Error(`No ${label} button`);
  }
  return found;
}

describe('Approvals', () => {
  it('shows a member’s change with who asked, what it does and the exact request, and approves it', async () => {
    await render();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Cloudflare change'));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Sites · from Sara · 5 min ago');
    expect(text).toContain('Create /accounts/a/workers/domains');
    expect(text).toContain('This puts shop.example.com on the Worker shop.');
    expect(document.querySelector('details pre')?.textContent).toContain('"hostname": "shop.example.com"');

    await act(async () => button('Approve').click());
    await vi.waitFor(() => expect(document.body.textContent).toContain('Nothing is waiting for you.'));
    expect(decisions).toEqual([{ id: change.id, decision: 'approve' }]);
    expect(document.body.textContent).toContain('Approved by Ada, and Cloudflare made the change');
  });

  it('lists members’ requests to make a draft a team project beside the changes', async () => {
    listed = {
      admin: true,
      waiting: [],
      decided: [],
      productionRequests: [
        {
          id: 'request-1',
          orgId: 'org-1',
          orgName: 'Sites',
          title: 'Todo app',
          note: null,
          previewUrl: 'https://todo.example.com',
          requesterName: 'Sara',
          requesterEmail: 'sara@example.com',
          createdAt: Date.now(),
          updatedAt: null,
        },
      ],
    };
    await render();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Team project request'));

    expect(document.body.textContent).toContain('Todo app');
    expect(document.querySelector('a[href="https://todo.example.com"]')?.textContent).toBe('Try the draft');
    await act(async () => button('Decline').click());
    expect(document.querySelector('button[aria-label="Decline request: Todo app"]')).not.toBeNull();
  });

  it('says there is nothing for someone who is no team’s admin', async () => {
    listed = { admin: false, waiting: [], decided: [], productionRequests: [] };
    await render();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('You’re not an admin of any team, so nothing waits for you here.'),
    );
  });
});
