// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageTip } from './TerminalPanel.client';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<StorageTip />));
}

function button(name: string) {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) {
    throw new Error(`No ${name} button.`);
  }
  return found;
}

describe('StorageTip', () => {
  it('shows the tip until it is closed, then stays closed with a way to show it again', async () => {
    await render();
    expect(document.body.textContent).toContain('Your project and home folder (~) are kept.');

    await act(async () => button('Close tip').click());
    expect(document.body.textContent).not.toContain('are kept');

    // Closed in this browser: the next terminal opens without it.
    await act(async () => root?.unmount());
    await render();
    expect(document.body.textContent).not.toContain('are kept');

    await act(async () => button('What this workspace keeps').click());
    expect(document.body.textContent).toContain('are kept');
  });
});
