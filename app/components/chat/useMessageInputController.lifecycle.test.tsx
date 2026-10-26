// @vitest-environment jsdom

import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { useMessageInputController } from './useMessageInputController';

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ prefill: undefined }),
}));

vi.mock('~/lib/stores/userId', async () => ({
  useCloudChefAuthKind: () => 'fullyLoggedIn',
  userIdStore: (await import('nanostores')).atom('user'),
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
    await act(async () => controller?.runPrimaryAction());
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
});
