// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesSentence } from '~/components/chat/ProjectChangesNotice.client';
import { hereSentence } from '~/components/header/ProjectPresence.client';
import { resetUserRuntimeSession } from './runtime-session';
import {
  agentWorkingStore,
  projectChangesNoticeStore,
  projectVisitorsStore,
  useProjectPresence,
} from './project-presence.client';

const RUNTIME = 'https://runtime.example.workers.dev';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const SARA = { id: 'u-sara', name: 'Sara', image: null, working: false };

let presenceAnswer: () => Response;
const reports: unknown[] = [];

async function network(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    return Response.json({ result: { projectId: PROJECT } });
  }
  if (url === `/api/projects/${PROJECT}/presence`) {
    reports.push(JSON.parse(String(init?.body)));
    return presenceAnswer();
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

function Presence() {
  useProjectPresence('chat-1');
  return null;
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(network));
  resetUserRuntimeSession();
  reports.length = 0;
  presenceAnswer = () =>
    Response.json({ here: [SARA], changedSince: { count: 2, people: ['Sara'], latestAt: Date.now() - 60_000 } });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  agentWorkingStore.set(false);
  vi.unstubAllGlobals();
});

async function open() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<Presence />));
}

describe('presence on an open project', () => {
  it('shows who else is here, tells of changes since the last visit, and says when the agent starts working', async () => {
    await open();
    await vi.waitFor(() => expect(projectVisitorsStore.get()).toEqual([SARA]));
    expect(projectChangesNoticeStore.get()?.count).toBe(2);
    expect(reports).toEqual([{ working: false }]);

    await act(async () => agentWorkingStore.set(true));
    await vi.waitFor(() => expect(reports).toContainEqual({ working: true }));

    // Leaving the project says so at once, and nobody is shown any more.
    await act(async () => root?.unmount());
    root = undefined;
    expect(reports.at(-1)).toEqual({ working: false, leaving: true });
    expect(projectVisitorsStore.get()).toEqual([]);
    expect(projectChangesNoticeStore.get()).toBeNull();
  });

  it('leaves alone a project the control plane doesn’t keep', async () => {
    presenceAnswer = () => Response.json({ error: 'Not found.' }, { status: 404 });
    await open();
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    await act(async () => agentWorkingStore.set(true));
    await act(async () => root?.unmount());
    root = undefined;
    expect(reports).toEqual([{ working: false }]);
  });
});

describe('what people read', () => {
  it('names who is here, and who is working', () => {
    expect(hereSentence([SARA])).toBe('Sara is here');
    expect(hereSentence([{ ...SARA, working: true }])).toBe('Sara is here, working with CloudChef');
    expect(hereSentence([SARA, { ...SARA, id: 'u-ada', name: 'Ada', working: true }])).toBe(
      'Sara and Ada are here; Ada is working with CloudChef',
    );
    expect(
      hereSentence([
        SARA,
        { ...SARA, id: 'a', name: 'Ada' },
        { ...SARA, id: 'b', name: 'Bo' },
        { ...SARA, id: 'c', name: 'Cy' },
      ]),
    ).toBe('Sara, Ada and 2 others are here');
  });

  it('says what changed since the last visit in everyday words', () => {
    const now = 10_000_000;
    expect(changesSentence({ count: 1, people: ['Sara'], latestAt: now - 600_000 }, now)).toBe(
      'Sara published a change 10 minutes ago, since you were last here.',
    );
    expect(changesSentence({ count: 3, people: ['Sara', 'Ada'], latestAt: now - 7_200_000 }, now)).toBe(
      'Sara and Ada published 3 changes since you were last here, the latest 2 hours ago.',
    );
    expect(changesSentence({ count: 1, people: [], latestAt: now }, now)).toBe(
      'Someone published a change 0 seconds ago, since you were last here.',
    );
  });
});
