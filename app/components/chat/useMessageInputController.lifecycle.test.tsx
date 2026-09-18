// @vitest-environment jsdom

import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';
import { messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { useMessageInputController } from './useMessageInputController';

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ prefill: undefined }),
}));

vi.mock('~/lib/cloudflare/runtime-session', () => ({
  fetchUserRuntime: vi.fn(),
}));

vi.mock('~/lib/stores/userId', () => ({
  isAuthenticated: () => true,
}));

vi.mock('./CloudChefAuthWrapper', () => ({
  useCloudChefAuth: () => ({ kind: 'fullyLoggedIn' }),
}));

type Controller = ReturnType<typeof useMessageInputController>;
type OnSend = (message: string, onAccepted?: () => void) => Promise<boolean>;

let controller: Controller | undefined;
let root: Root | undefined;

function Harness({ onSend, onMount }: { onSend: OnSend; onMount?: () => void }) {
  controller = useMessageInputController({
    isStreaming: false,
    onStop: vi.fn(),
    onSend,
    prefillEnabled: false,
  });
  useLayoutEffect(() => {
    onMount?.();
  }, [onMount]);
  return null;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setMessageInput('');
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  controller = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useMessageInputController lifecycle', () => {
  it('clears the unchanged global prompt when acceptance replaces the controller', async () => {
    let accept!: () => void;
    let finish!: (sent: boolean) => void;
    const onSend = vi.fn(
      (_message: string, onAccepted: () => void = () => undefined) =>
        new Promise<boolean>((resolve) => {
          accept = onAccepted;
          finish = resolve;
        }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<Harness key="old" onSend={onSend} />));
    await act(async () => setMessageInput('keep this draft'));
    await act(async () => controller?.handleButtonClick());
    expect(onSend).toHaveBeenCalledWith('keep this draft', expect.any(Function));

    await act(async () =>
      root?.render(
        <Harness
          key="replacement"
          onSend={onSend}
          onMount={() => {
            accept();
            finish(true);
          }}
        />,
      ),
    );

    expect(messageInputStore.get()).toBe('');
  });

  it('does not install refinement questions after prompt ownership changes while the request is pending', async () => {
    let resolveRequest!: (response: Response) => void;
    vi.mocked(fetchUserRuntime).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<Harness onSend={vi.fn(async () => true)} />));
    await act(async () => setMessageInput('original prompt'));

    let enhancement!: Promise<void>;
    await act(async () => {
      enhancement = controller!.enhancePrompt();
      await Promise.resolve();
    });
    expect(fetchUserRuntime).toHaveBeenCalledOnce();

    await act(async () => {
      setMessageInput('new draft');
      setMessageInput('original prompt');
    });
    await act(async () => {
      resolveRequest(
        Response.json({
          kind: 'questions',
          questions: [
            {
              id: 'audience',
              header: 'Audience',
              question: 'Who is this for?',
              options: [
                { id: 'team', label: 'Team', description: 'Internal collaborators.' },
                { id: 'public', label: 'Public', description: 'Anyone can use it.' },
              ],
              multi: false,
              recommendedOptionId: 'team',
            },
          ],
        }),
      );
      await enhancement;
    });

    expect(messageInputStore.get()).toBe('original prompt');
    expect(controller?.refinement).toBeNull();
  });
});
