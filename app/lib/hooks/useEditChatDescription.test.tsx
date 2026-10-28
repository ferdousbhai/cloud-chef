// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useEditChatDescription as UseEditChatDescription } from './useEditChatDescription';

const mocks = vi.hoisted(() => ({
  executeDataOperation: vi.fn(),
  setDescription: Symbol('setDescription'),
  workspaceId: 'chat-1',
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('~/lib/cloudflare/data-api', () => ({
  api: {
    messages: {
      setDescription: mocks.setDescription,
    },
  },
}));
vi.mock('~/lib/cloudflare/client', () => ({ executeDataOperation: mocks.executeDataOperation }));
vi.mock('~/lib/stores/userId', () => ({ useUserIdOrNullOrLoading: () => 'user-1' }));
vi.mock('~/lib/stores/workspaceId', () => ({ useWorkspaceId: () => mocks.workspaceId }));
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
  mocks.workspaceId = 'chat-1';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// SAFETY: the hook reads only `target.value` from a change event.
const change = (value: string) => ({ target: { value } }) as React.ChangeEvent<HTMLInputElement>;
// SAFETY: the hook calls only `preventDefault` on a submit.
const submitEvent = { preventDefault: () => undefined } as React.FormEvent;
// SAFETY: the hook reads only `key` from a key event.
const escape = { key: 'Escape' } as React.KeyboardEvent<HTMLInputElement>;

describe('useEditChatDescription', () => {
  it('saves a title with accents, colons, and ampersands, and refuses an empty one or one over 200 characters', async () => {
    mocks.executeDataOperation.mockResolvedValue(undefined);
    await act(async () => root?.render(<Harness />));

    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('x'.repeat(201))));
    await act(async () => latest.handleSubmit(submitEvent));
    act(() => latest.handleChange(change('   ')));
    await act(async () => latest.handleSubmit(submitEvent));
    expect(mocks.toastError).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenCalledWith('Description must be between 1 and 200 characters.');
    expect(mocks.executeDataOperation).not.toHaveBeenCalled();

    act(() => latest.handleChange(change('  Café menu: v2 & more 🍰  ')));
    await act(async () => latest.handleSubmit(submitEvent));
    expect(mocks.executeDataOperation).toHaveBeenCalledWith(mocks.setDescription, {
      id: 'chat-1',
      description: 'Café menu: v2 & more 🍰',
    });
    expect(latest.currentDescription).toBe('Café menu: v2 & more 🍰');
    expect(latest.editing).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Chat description updated successfully');
  });

  it('puts the name back when the field is left or Escape is pressed, without asking the server', async () => {
    await act(async () => root?.render(<Harness />));

    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('Draft')));
    act(() => latest.handleBlur());
    expect(latest).toMatchObject({ editing: false, currentDescription: 'Old title' });

    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('Another draft')));
    act(() => latest.handleKeyDown(escape));
    expect(latest).toMatchObject({ editing: false, currentDescription: 'Old title' });
    expect(mocks.executeDataOperation).not.toHaveBeenCalled();
  });

  it('admits one save at a time, and leaving the field while it saves keeps the new name', async () => {
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockReturnValue(saveRequest.promise);
    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('First title')));

    let firstSubmit!: Promise<void>;
    act(() => {
      firstSubmit = latest.handleSubmit(submitEvent);
    });
    act(() => latest.handleBlur());
    act(() => latest.handleChange(change('Second title')));
    await act(async () => latest.handleSubmit(submitEvent));

    expect(mocks.executeDataOperation).toHaveBeenCalledTimes(1);
    expect(mocks.executeDataOperation).toHaveBeenCalledWith(mocks.setDescription, {
      id: 'chat-1',
      description: 'First title',
    });

    await act(async () => {
      saveRequest.resolve();
      await firstSubmit;
    });
    expect(latest).toMatchObject({ editing: false, currentDescription: 'First title' });
  });

  it('starts over for another chat, and a save still pending for the first does not touch it', async () => {
    const saveRequest = deferred<void>();
    mocks.executeDataOperation.mockReturnValue(saveRequest.promise);
    await act(async () => root?.render(<Harness />));
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('Chat one title')));
    let submit!: Promise<void>;
    act(() => {
      submit = latest.handleSubmit(submitEvent);
    });

    mocks.workspaceId = 'chat-2';
    await act(async () => root?.render(<Harness initialDescription="Chat two" />));
    expect(latest).toMatchObject({ editing: false, currentDescription: 'Chat two' });
    act(() => latest.toggleEditMode());
    act(() => latest.handleChange(change('Chat two draft')));

    await act(async () => {
      saveRequest.resolve();
      await submit;
    });
    expect(latest).toMatchObject({ editing: true, currentDescription: 'Chat two draft' });
  });
});
