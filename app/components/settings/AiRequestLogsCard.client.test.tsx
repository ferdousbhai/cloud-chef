// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiRequestLogsCard } from './AiRequestLogsCard.client';

let root: Root | undefined;
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<AiRequestLogsCard />));
}

function checkbox(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!found) {
    throw new Error('No logging checkbox');
  }
  return found;
}

describe('AiRequestLogsCard', () => {
  it("shows the person's saved choice and turns logging off for their next requests", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ contentLogging: true }));
    await render();
    expect(checkbox().checked).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/ai-gateway-logging', { credentials: 'same-origin' });

    fetchMock.mockResolvedValueOnce(Response.json({ contentLogging: false }));
    await act(async () => checkbox().click());

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/settings/ai-gateway-logging/update',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ contentLogging: false }) }),
    );
    expect(checkbox().checked).toBe(false);
    expect(document.body.textContent).toContain('Logs already recorded stay in the account.');
  });

  it('stays unchangeable while the choice is unknown, and keeps the saved choice when saving fails', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Sign in first.' }, { status: 401 }));
    await render();
    expect(checkbox().disabled).toBe(true);
    expect(document.body.textContent).toContain('Sign in first.');

    await act(async () => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    fetchMock.mockResolvedValueOnce(Response.json({ contentLogging: false }));
    await render();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unable to save. Try again.' }, { status: 500 }));
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(document.body.textContent).toContain('Unable to save. Try again.');
  });
});
