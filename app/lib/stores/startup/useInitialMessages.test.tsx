// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userIdStore } from '~/lib/stores/userId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useInitialMessagesState } from './useInitialMessages';
import { description } from '~/lib/stores/description';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { TRANSCRIPT_HISTORY_FORMAT_VERSION } from 'cloudchef-agent/transcript';

vi.mock('~/lib/cloudflare/runtime-session', () => ({
  fetchUserRuntime: (path: string, init?: RequestInit) => fetch(path, init),
}));
type TranscriptRequestBody = { chatId: string; subchatIndex?: number };
type ChatOnRuntime = { description: string; latestSubchatIndex: number };

/** Serves the runtime's transcript endpoint: the chat `answer` returns, with no saved history, or a missing chat. */
function stubTranscriptEndpoint(answer: (body: TranscriptRequestBody) => Promise<ChatOnRuntime | null>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    // SAFETY: this stub only ever serves the transcript request, whose body the production caller
    // builds with exactly these fields.
    const body = JSON.parse(String(init?.body)) as TranscriptRequestBody;
    const chat = await answer(body);
    if (!chat) {
      return Response.json({ status: 'missing' });
    }
    const subchatIndex = body.subchatIndex ?? chat.latestSubchatIndex;
    return Response.json({
      status: 'ready',
      version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
      initialId: body.chatId,
      description: chat.description,
      transcript: { agentName: `${body.chatId}--transcript-${subchatIndex}-0`, subchatIndex },
      checkpoint: null,
      messages: [],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useInitialMessages', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    subchatIndexStore.set(0);
    userIdStore.set(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    userIdStore.set(undefined);
    subchatIndexStore.set(undefined);
    description.set(undefined);
    document.body.replaceChildren();
  });

  it('reloads a project when authentication replaces a temporary guest session', async () => {
    // The runtime answers for whoever the runtime session belongs to.
    const fetchMock = stubTranscriptEndpoint(async () =>
      userIdStore.get() === 'stale-session' ? null : { description: 'Project', latestSubchatIndex: 0 },
    );

    const seen: Array<'loading' | 'missing' | 'ready'> = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const messages = useInitialMessagesState('project-id').initialMessages;
      const state = messages === undefined ? 'loading' : messages === null ? 'missing' : 'ready';
      useEffect(() => {
        seen.push(state);
      }, [state]);
      return <span>{state}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      userIdStore.set('stale-session');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('missing'));
    });

    await act(async () => {
      userIdStore.set('signed-in-user');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready'));
    });
    expect(seen).toContain('missing');
    expect(seen.at(-1)).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(description.get()).toBe('Project');

    await act(async () => root.unmount());
  });

  it('hides messages from the prior subchat immediately after navigation', async () => {
    let finishSubchatLoad: (() => void) | undefined;
    const subchatLoad = new Promise<void>((resolve) => {
      finishSubchatLoad = resolve;
    });
    stubTranscriptEndpoint(async (body) => {
      if (body.subchatIndex === 1) {
        await subchatLoad;
      }
      return { description: 'Project', latestSubchatIndex: 0 };
    });

    const states: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const messages = useInitialMessagesState('project-id').initialMessages;
      const state =
        messages === undefined ? 'loading' : messages === null ? 'missing' : `ready-${messages.loadedSubchatIndex}`;
      useEffect(() => {
        states.push(state);
      }, [state]);
      return <span>{state}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      userIdStore.set('signed-in-subchat-user');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready-0'));
    });

    await act(() => {
      subchatIndexStore.set(1);
    });
    expect(container.textContent).toBe('loading');

    await act(async () => {
      finishSubchatLoad?.();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready-1'));
    });
    expect(states).toContain('loading');

    await act(async () => root.unmount());
  });

  it('adopts a newer latest subchat discovered during server revalidation', async () => {
    let latestSubchatIndex = 0;
    stubTranscriptEndpoint(async () => ({ description: 'Project', latestSubchatIndex }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const messages = useInitialMessagesState('project-id').initialMessages;
      return <span>{messages ? `ready-${messages.loadedSubchatIndex}` : 'loading'}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      userIdStore.set('signed-in-revalidation-user');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready-0'));
    });

    latestSubchatIndex = 1;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['cloudchef-local', 'transcripts', 'signed-in-revalidation-user'],
      });
      await vi.waitFor(() => expect(container.textContent).toBe('ready-1'));
    });

    await act(async () => root.unmount());
  });
});
