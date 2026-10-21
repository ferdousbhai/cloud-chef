// @vitest-environment jsdom

import { act, startTransition, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useEditChatDescription as UseEditChatDescription } from './useEditChatDescription';

const mocks = vi.hoisted(() => ({
  executeDataOperation: vi.fn(),
  getDescription: Symbol('getDescription'),
  setDescription: Symbol('setDescription'),
  chatId: 'chat-1',
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('~/lib/cloudflare/data-api', () => ({
  api: {
    messages: {
      get: mocks.getDescription,
      setDescription: mocks.setDescription,
    },
  },
}));
vi.mock('~/lib/cloudflare/client', () => ({ executeDataOperation: mocks.executeDataOperation }));
vi.mock('~/lib/stores/userId', () => ({ useUserIdOrNullOrLoading: () => 'user-1' }));
vi.mock('~/lib/stores/chatId', () => ({ useChatId: () => mocks.chatId }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { useEditChatDescription } from './useEditChatDescription';

type HookResult = ReturnType<typeof UseEditChatDescription>;
let root: Root | undefined;
let latest: HookResult;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.executeDataOperation.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.chatId = 'chat-1';
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

function Harness({ initialDescription = 'Old title' }: { initialDescription?: string }) {
  latest = useEditChatDescription({ initialDescription });
  return null;
}

function SuspendingHarness({ initialDescription, suspend }: { initialDescription: string; suspend?: Promise<never> }) {
  const result = useEditChatDescription({ initialDescription });
  if (suspend) {
    throw suspend;
  }
  latest = result;
  return <output>{result.currentDescription}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('useEditChatDescription', () => {
  it('saves a title with accents, colons, and ampersands, and refuses only one over 200 characters', async () => {
    mocks.executeDataOperation.mockResolvedValue(undefined);
    await act(async () => root?.render(<Harness />));
    // SAFETY: the hook reads only `target.value` from a change event and calls only `preventDefault` on a submit.
    const change = (value: string) => ({ target: { value } }) as React.ChangeEvent<HTMLInputElement>;
    // SAFETY: as above.
    const submitEvent = { preventDefault: () => undefined } as React.FormEvent;

    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('x'.repeat(201))));
    await act(async () => latest.handleSubmit(submitEvent));
    expect(mocks.toastError).toHaveBeenCalledWith('Description must be between 1 and 200 characters.');
    expect(mocks.executeDataOperation).not.toHaveBeenCalled();

    act(() => latest.handleChange(change('  Café menu: v2 & more 🍰  ')));
    await act(async () => latest.handleSubmit(submitEvent));
    expect(mocks.executeDataOperation).toHaveBeenCalledWith(mocks.setDescription, {
      id: 'chat-1',
      sessionId: 'user-1',
      description: 'Café menu: v2 & more 🍰',
    });
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it('does not let an earlier blur response overwrite or reopen a submitted edit', async () => {
    const blurRequest = deferred<{ description: string }>();
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockImplementation((operation: symbol) =>
      operation === mocks.getDescription ? blurRequest.promise : saveRequest.promise,
    );

    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'New title' } } as React.ChangeEvent<HTMLInputElement>));

    let blur!: Promise<void>;
    let submit!: Promise<void>;
    act(() => {
      blur = latest.handleBlur();
      submit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });

    await act(async () => {
      blurRequest.resolve({ description: 'Old title' });
      await blur;
    });
    expect(latest.currentDescription).toBe('New title');
    expect(latest.editing).toBe(true);

    await act(async () => {
      saveRequest.resolve();
      await submit;
    });
    expect(latest.currentDescription).toBe('New title');
    expect(latest.editing).toBe(false);
  });

  it('ignores a save completion after the active chat changes', async () => {
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockReturnValue(saveRequest.promise);
    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'Chat one title' } } as React.ChangeEvent<HTMLInputElement>));

    let submit!: Promise<void>;
    act(() => {
      submit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    mocks.chatId = 'chat-2';
    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'Chat two draft' } } as React.ChangeEvent<HTMLInputElement>));

    await act(async () => {
      saveRequest.resolve();
      await submit;
    });
    expect(latest.currentDescription).toBe('Chat two draft');
    expect(latest.editing).toBe(true);
  });

  it('allows a new chat to save while an old chat save is still pending', async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    mocks.executeDataOperation.mockImplementation((_operation: symbol, input: { id: string }) =>
      input.id === 'chat-1' ? firstSave.promise : secondSave.promise,
    );
    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'Chat one title' } } as React.ChangeEvent<HTMLInputElement>));

    let firstSubmit!: Promise<void>;
    act(() => {
      firstSubmit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });

    mocks.chatId = 'chat-2';
    await act(async () => root?.render(<Harness initialDescription="Chat two" />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'Chat two title' } } as React.ChangeEvent<HTMLInputElement>));

    let secondSubmit!: Promise<void>;
    act(() => {
      secondSubmit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });

    expect(mocks.executeDataOperation).toHaveBeenCalledTimes(2);
    expect(mocks.executeDataOperation).toHaveBeenLastCalledWith(mocks.setDescription, {
      id: 'chat-2',
      sessionId: 'user-1',
      description: 'Chat two title',
    });

    await act(async () => {
      secondSave.resolve();
      await secondSubmit;
    });
    expect(latest.currentDescription).toBe('Chat two title');
    expect(latest.editing).toBe(false);

    await act(async () => {
      firstSave.resolve();
      await firstSubmit;
    });
    expect(latest.currentDescription).toBe('Chat two title');
  });

  it('does not publish canonical props from a render that never commits', async () => {
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockReturnValue(saveRequest.promise);
    await act(async () =>
      root?.render(
        <Suspense fallback={null}>
          <SuspendingHarness initialDescription="Old title" />
        </Suspense>,
      ),
    );
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'Manual title' } } as React.ChangeEvent<HTMLInputElement>));

    let submit!: Promise<void>;
    act(() => {
      submit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    const neverCommits = new Promise<never>(() => undefined);
    await act(async () => {
      startTransition(() =>
        root?.render(
          <Suspense fallback={null}>
            <SuspendingHarness initialDescription="Uncommitted title" suspend={neverCommits} />
          </Suspense>,
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      saveRequest.resolve();
      await submit;
    });

    expect(document.querySelector('output')?.textContent).toBe('Manual title');
  });

  it('retains a successful local save when the canonical title changes while it is pending', async () => {
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockReturnValue(saveRequest.promise);
    await act(async () => root?.render(<Harness initialDescription="Old title" />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'Manual title' } } as React.ChangeEvent<HTMLInputElement>));

    let submit!: Promise<void>;
    act(() => {
      submit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    await act(async () => root?.render(<Harness initialDescription="Generated title" />));

    await act(async () => {
      saveRequest.resolve();
      await submit;
    });
    expect(latest.currentDescription).toBe('Manual title');
    expect(latest.editing).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Chat description updated successfully');
  });

  it('admits only one save at a time so requests cannot overwrite each other out of order', async () => {
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockReturnValue(saveRequest.promise);
    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange({ target: { value: 'First title' } } as React.ChangeEvent<HTMLInputElement>));

    let firstSubmit!: Promise<void>;
    act(() => {
      firstSubmit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    act(() => latest.handleChange({ target: { value: 'Second title' } } as React.ChangeEvent<HTMLInputElement>));

    let secondSubmit!: Promise<void>;
    act(() => {
      secondSubmit = latest.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    await act(async () => secondSubmit);

    expect(mocks.executeDataOperation).toHaveBeenCalledTimes(1);
    expect(mocks.executeDataOperation).toHaveBeenCalledWith(mocks.setDescription, {
      id: 'chat-1',
      sessionId: 'user-1',
      description: 'First title',
    });

    await act(async () => {
      saveRequest.resolve();
      await firstSubmit;
    });
    expect(latest.currentDescription).toBe('First title');
  });
});
