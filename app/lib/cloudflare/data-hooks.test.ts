// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRuntimeRequestError } from './client';
import { useAllConversationsState } from './data-hooks';
import { queryClient as collectionQueryClient } from '~/lib/stores/reactQueryClient';

const executeDataOperation = vi.hoisted(() => vi.fn());

vi.mock('./client', () => {
  class UserRuntimeRequestError extends Error {
    constructor(
      message: string,
      readonly status: number | undefined,
      readonly retryable: boolean,
    ) {
      super(message);
    }
  }

  return {
    UserRuntimeRequestError,
    executeDataOperation,
  };
});

function useSubchatHistoryError() {
  return useAllConversationsState({ workspaceId: 'error-chat', sessionId: 'error-user' }).error;
}

async function waitForReactUpdate(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(() => Promise.resolve());
    assertion();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  executeDataOperation.mockReset();
  collectionQueryClient.clear();
  document.body.replaceChildren();
});

describe('Query DB collection errors', () => {
  it('surfaces an initial subchat history failure after the source collection becomes ready', async () => {
    executeDataOperation.mockRejectedValue(new UserRuntimeRequestError('cold load failed', 400, false));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const error = useSubchatHistoryError();
      return createElement('span', null, error instanceof Error ? error.message : 'none');
    }

    await act(async () => root.render(createElement(Harness)));
    await waitForReactUpdate(() => expect(container.textContent).toBe('cold load failed'));
    await act(async () => root.unmount());
  });
});
