// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubchatBar } from './SubchatBar';

const fileSavingState = vi.hoisted(() => ({ value: false }));
let root: Root | undefined;

vi.mock('~/lib/stores/fileUpdateCounter', () => ({
  useAreFilesSaving: () => fileSavingState.value,
}));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  fileSavingState.value = false;
  document.body.replaceChildren();
});

describe('SubchatBar', () => {
  it('blocks history and project-changing actions while files are saving', () => {
    fileSavingState.value = true;
    document.body.innerHTML = renderSubchatBar({
      subchats: [subchat(0, 'Initial build'), subchat(1, 'Add live voting')],
      currentSubchatIndex: 0,
    });

    expect(document.querySelector<HTMLButtonElement>('button[aria-label^="Switch chat."]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Next chat"]')?.disabled).toBe(true);
  });

  it('keeps the confirmation open and prevents repeat submission when creation fails', async () => {
    let finishCreation: ((created: boolean) => void) | undefined;
    const handleCreateSubchat = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCreation = resolve;
        }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SubchatBar
          chatId="chat-1"
          subchats={[subchat(0, 'Initial build')]}
          currentSubchatIndex={0}
          isStreaming={false}
          chatDisabled={false}
          userId="user"
          handleCreateSubchat={handleCreateSubchat}
          handleRenameSubchat={() => Promise.resolve(true)}
          isSubchatLoaded
        />,
      );
    });

    const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Start a new chat"]');
    expect(openButton).not.toBeNull();
    act(() => openButton?.click());

    const createButton = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'New chat',
    );
    const cancelButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(createButton).toBeDefined();
    act(() => createButton?.click());

    expect(handleCreateSubchat).toHaveBeenCalledTimes(1);
    expect(createButton?.disabled).toBe(true);
    expect(cancelButton?.disabled).toBe(true);

    await act(async () => finishCreation?.(false));

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(createButton?.disabled).toBe(false);
  });

  it.each([
    {
      name: 'account',
      initial: { userId: 'user-1', chatId: 'chat-1', index: 0 },
      next: { userId: 'user-2', chatId: 'chat-1', index: 0 },
    },
    {
      name: 'chat',
      initial: { userId: 'user-1', chatId: 'chat-1', index: 0 },
      next: { userId: 'user-1', chatId: 'chat-2', index: 0 },
    },
    {
      name: 'subchat',
      initial: { userId: 'user-1', chatId: 'chat-1', index: 0 },
      next: { userId: 'user-1', chatId: 'chat-1', index: 1 },
    },
  ])('does not let a pending create block or close a dialog in a new $name scope', async ({ initial, next }) => {
    const oldCreate = deferred<boolean>();
    const handleCreateSubchat = vi.fn().mockReturnValue(oldCreate.promise);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (context: typeof initial) => (
      <SubchatBar
        chatId={context.chatId}
        subchats={[subchat(context.index, `Chat ${context.index + 1}`)]}
        currentSubchatIndex={context.index}
        isStreaming={false}
        chatDisabled={false}
        userId={context.userId}
        handleCreateSubchat={handleCreateSubchat}
        handleRenameSubchat={() => Promise.resolve(true)}
        isSubchatLoaded
      />
    );

    await act(async () => root?.render(render(initial)));
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Start a new chat"]')?.click());
    const oldCreateButton = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'New chat',
    );
    act(() => oldCreateButton?.click());
    expect(oldCreateButton?.disabled).toBe(true);

    await act(async () => root?.render(render(next)));
    const newOpenButton = document.querySelector<HTMLButtonElement>('button[aria-label="Start a new chat"]');
    expect(newOpenButton?.disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => newOpenButton?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      oldCreate.resolve(true);
      await oldCreate.promise;
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps simultaneous create requests pending in their own scopes', async () => {
    const firstCreate = deferred<boolean>();
    const secondCreate = deferred<boolean>();
    const handleCreateSubchat = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(firstCreate.promise)
      .mockReturnValueOnce(secondCreate.promise);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (userId: string) => (
      <SubchatBar
        chatId="chat-1"
        subchats={[subchat(0, 'Initial build')]}
        currentSubchatIndex={0}
        isStreaming={false}
        chatDisabled={false}
        userId={userId}
        handleCreateSubchat={handleCreateSubchat}
        handleRenameSubchat={() => Promise.resolve(true)}
        isSubchatLoaded
      />
    );
    const startCreate = () => {
      act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Start a new chat"]')?.click());
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === 'New chat',
      );
      act(() => confirm?.click());
    };

    await act(async () => root?.render(render('user-1')));
    startCreate();
    await act(async () => root?.render(render('user-2')));
    startCreate();

    await act(async () => root?.render(render('user-1')));
    const firstScopeButton = document.querySelector<HTMLButtonElement>('button[aria-label="Start a new chat"]');
    expect(firstScopeButton?.disabled).toBe(true);

    await act(async () => {
      secondCreate.resolve(false);
      await secondCreate.promise;
    });
    expect(firstScopeButton?.disabled).toBe(true);

    await act(async () => {
      firstCreate.resolve(false);
      await firstCreate.promise;
    });
    expect(firstScopeButton?.disabled).toBe(false);
  });

  it('keeps an old account rename from disabling or closing a dialog in the new account', async () => {
    const oldRename = deferred<boolean>();
    const handleRenameSubchat = vi
      .fn<(_: string) => Promise<boolean>>()
      .mockReturnValueOnce(oldRename.promise)
      .mockResolvedValueOnce(true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (userId: string, title: string) => (
      <SubchatBar
        chatId="chat-1"
        subchats={[subchat(0, title)]}
        currentSubchatIndex={0}
        isStreaming={false}
        chatDisabled={false}
        userId={userId}
        handleCreateSubchat={() => Promise.resolve(true)}
        handleRenameSubchat={handleRenameSubchat}
        isSubchatLoaded
      />
    );

    await act(async () => root?.render(render('user-1', 'First project')));
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Rename current chat:"]')?.click());
    const oldInput = document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(oldInput, 'Renamed first project');
      oldInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const oldSaveButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save title',
    );
    act(() => oldSaveButton?.click());
    expect(oldSaveButton?.disabled).toBe(true);

    await act(async () => root?.render(render('user-2', 'Second project')));
    const newRenameButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename current chat: Second project"]',
    );
    expect(newRenameButton?.disabled).toBe(false);
    act(() => newRenameButton?.click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]')?.value).toBe('Second project');

    await act(async () => {
      oldRename.resolve(true);
      await oldRename.promise;
    });

    expect(document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]')?.value).toBe('Second project');
    const newSaveButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save title',
    );
    await act(async () => newSaveButton?.click());
    expect(handleRenameSubchat).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    {
      name: 'subchat',
      initial: { chatId: 'chat-1', index: 0, subchats: [subchat(0, 'First chat'), subchat(1, 'Second chat')] },
      next: { chatId: 'chat-1', index: 1, subchats: [subchat(0, 'First chat'), subchat(1, 'Second chat')] },
    },
    {
      name: 'chat',
      initial: { chatId: 'chat-1', index: 0, subchats: [subchat(0, 'First project')] },
      next: { chatId: 'chat-2', index: 0, subchats: [subchat(0, 'Second project')] },
    },
  ])('discards a stale rename when the active $name changes', async ({ initial, next }) => {
    const handleRenameSubchat = vi.fn().mockResolvedValue(true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (context: typeof initial) => (
      <SubchatBar
        chatId={context.chatId}
        subchats={context.subchats}
        currentSubchatIndex={context.index}
        isStreaming={false}
        chatDisabled={false}
        userId="user"
        handleCreateSubchat={() => Promise.resolve(true)}
        handleRenameSubchat={handleRenameSubchat}
        isSubchatLoaded
      />
    );

    await act(async () => root?.render(render(initial)));
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Rename current chat:"]')?.click());
    const oldInput = document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(oldInput, 'Stale title');
      oldInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => root?.render(render(next)));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(handleRenameSubchat).not.toHaveBeenCalled();

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Rename current chat:"]')?.click());
    const nextInput = document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
    expect(nextInput?.value).toBe(next.subchats[next.index]?.description);
  });
});

function renderSubchatBar({
  subchats,
  currentSubchatIndex,
}: {
  subchats: ReturnType<typeof subchat>[];
  currentSubchatIndex: number;
}) {
  return renderToStaticMarkup(
    <SubchatBar
      chatId="chat-1"
      subchats={subchats}
      currentSubchatIndex={currentSubchatIndex}
      isStreaming={false}
      chatDisabled={false}
      userId="user"
      handleCreateSubchat={() => Promise.resolve(true)}
      handleRenameSubchat={() => Promise.resolve(true)}
      isSubchatLoaded
    />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function subchat(subchatIndex: number, description: string) {
  return {
    subchatIndex,
    description,
    updatedAt: subchatIndex,
    transcript: {
      agentName: `chat-${subchatIndex}`,
      generation: 0,
      subchatIndex,
    },
  };
}
