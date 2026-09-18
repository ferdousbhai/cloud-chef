// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { PENDING_PROMPT_STORAGE_KEY, PENDING_SUBMIT_STORAGE_KEY } from '~/utils/constants';
import { useMessageInputController } from './useMessageInputController';

const auth = vi.hoisted(() => ({
  createCloudflareReturnURL: vi.fn(() => 'http://localhost/'),
  signInWithCloudflare: vi.fn(async () => undefined),
}));
const session = vi.hoisted(() => ({ kind: 'fullyLoggedIn' as 'fullyLoggedIn' | 'unauthenticated' | 'loading' }));

vi.mock('~/lib/auth-client', () => auth);

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
  useCloudChefAuth: () => ({ kind: session.kind }),
}));

type OnSend = (message: string, onAccepted?: () => void) => Promise<boolean>;

let controller: ReturnType<typeof useMessageInputController> | undefined;
let root: Root | undefined;

function Harness({ onSend }: { onSend: OnSend }) {
  controller = useMessageInputController({ isStreaming: false, onStop: vi.fn(), onSend });
  return null;
}

async function mountComposer(onSend: OnSend) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness onSend={onSend} />));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  session.kind = 'fullyLoggedIn';
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  setMessageInput('');
  auth.signInWithCloudflare.mockClear();
  auth.createCloudflareReturnURL.mockClear();
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

describe('continuing a submit that stopped to connect Cloudflare', () => {
  it('finishes the instruction the person already gave, exactly once', async () => {
    window.sessionStorage.setItem(PENDING_PROMPT_STORAGE_KEY, 'Build a launch checklist.');
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, 'Build a launch checklist.');
    const onSend = vi.fn(async () => true);

    await mountComposer(onSend);

    expect(onSend).toHaveBeenCalledWith('Build a launch checklist.', expect.any(Function));
    expect(onSend).toHaveBeenCalledOnce();
    // Spent by reading it: a reload, or a second composer, must not build again.
    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBeNull();

    await act(async () => root?.unmount());
    root = undefined;
    await mountComposer(onSend);

    expect(onSend).toHaveBeenCalledOnce();
  });

  it('waits for the person when the prompt changed while they were away', async () => {
    window.sessionStorage.setItem(PENDING_PROMPT_STORAGE_KEY, 'Build a launch checklist for the team.');
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, 'Build a launch checklist.');
    const onSend = vi.fn(async () => true);

    await mountComposer(onSend);

    expect(onSend).not.toHaveBeenCalled();
    expect(messageInputStore.get()).toBe('Build a launch checklist for the team.');
    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBeNull();
  });

  it('never continues after an authorization that failed or was cancelled', async () => {
    window.history.replaceState(null, '', '/?cloudflare_authorization=failed');
    window.sessionStorage.setItem(PENDING_PROMPT_STORAGE_KEY, 'Build a launch checklist.');
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, 'Build a launch checklist.');
    const onSend = vi.fn(async () => true);

    await mountComposer(onSend);

    expect(onSend).not.toHaveBeenCalled();

    window.history.replaceState(null, '', '/');
    session.kind = 'unauthenticated';
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, 'Build a launch checklist.');
    await act(async () => root?.unmount());
    root = undefined;
    await mountComposer(onSend);

    expect(onSend).not.toHaveBeenCalled();
  });

  it('carries the continuation only when the connect was started by a submit', async () => {
    session.kind = 'unauthenticated';
    const onSend = vi.fn(async () => true);
    await mountComposer(onSend);
    await act(async () => setMessageInput('Build a launch checklist.'));

    await act(async () => controller?.handleButtonClick());

    expect(auth.signInWithCloudflare).toHaveBeenCalledWith('http://localhost/', {
      continuePrompt: 'Build a launch checklist.',
    });

    // The composer's own connect action is not a submit, so it carries nothing to finish.
    auth.signInWithCloudflare.mockClear();
    await act(async () => controller?.signIn());

    expect(auth.signInWithCloudflare).toHaveBeenCalledWith('http://localhost/', undefined);
    expect(onSend).not.toHaveBeenCalled();
  });
});
