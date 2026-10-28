// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, setThemePreference, themeStore } from '~/lib/stores/theme';
import { AppearanceCard } from './AppearanceCard';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function choice(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label,
  );
  if (!found) {
    throw new Error(`No ${label} choice`);
  }
  return found;
}

describe('Appearance', () => {
  it('is dark until another theme is chosen, keeps the choice, and can follow the device', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root?.render(<AppearanceCard />));

    expect(choice('Dark').getAttribute('aria-checked')).toBe('true');
    expect(themeStore.get()).toBe('dark');

    await act(async () => choice('Light').click());
    expect(choice('Light').getAttribute('aria-checked')).toBe('true');
    expect(themeStore.get()).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');

    await act(async () => choice('System').click());
    expect(localStorage.getItem(THEME_KEY)).toBe('system');
    setThemePreference('dark');
  });
});
